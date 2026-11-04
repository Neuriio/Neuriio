// Spotting a copied profile picture (user, 2026-11-01), even a cropped one. X gives every upload a new URL and re-compresses it, so
// neither the URL nor the bytes match: this compares what the picture looks like, in two steps.
//   1. Hashes: each picture stores a 144-bit dHash of itself and of many windows into it (WINDOWS). A cropped copy looks like one of
//      those windows, so its hash lands near that window's. The database shortlists suspects by that (launch_claims).
//   2. Confirmation: the hashes alone are too loose to trust (8% of different pictures come close somewhere), so each suspect window is
//      compared directly, pixel by pixel, against a small stored copy of the picture (normalized correlation).
// Measured on 75 real X pictures, copies re-compressed to JPEG quality 60: 0 of 5,550 different pairs wrongly matched (their best
// correlation: 0.74). Copies caught, by how much of the picture is kept: 80-99% about 96%, 60-80% about 93%, 50-60% about 81%, 40-50%
// about 54%, 30-40% about 38%. Mirrored copies and copies with borders added are checked too.
import { Buffer } from "node:buffer";
import jpeg from "npm:jpeg-js@0.4.4";
import { PNG } from "npm:pngjs@7.0.0";

/** The database shortlists a window this many bits (of 144) or fewer away. */
export const PFP_HASH_BITS = 42;
/** A shortlisted window this correlated with the picture is a copy. Different real pictures topped out at 0.74. */
export const PFP_CONFIRM = 0.8;
const MAX_BYTES = 5_000_000;
const FETCH_MS = 5_000;
const WORK = 128; // pictures are reduced to this many greys per side, whatever their size
const THUMB = 64; // the stored copy, per side
const HASH_W = 13;
const HASH_H = 12;
const NUDGE = 3; // how far around a window to look, in thumb pixels: windows are a grid, crops land between them
const FLAT = 25; // brightness variance under this says nothing: a blank area matches any other blank area

export type Rgba = { width: number; height: number; data: Uint8Array };
type Greys = Float64Array; // size x size
export type Window = readonly [x: number, y: number, size: number]; // fractions of the picture

/** Every window hashed, the whole picture first: zoom levels from all of it to 30%, each at 9 x 9 positions. */
export const WINDOWS: readonly Window[] = (() => {
  const out: Window[] = [[0, 0, 1]];
  for (let z = 95; z >= 30; z -= 5) {
    const size = z / 100;
    for (let a = 0; a < 9; a++) {
      for (let b = 0; b < 9; b++) out.push([((1 - size) * a) / 8, ((1 - size) * b) / 8, size]);
    }
  }
  return out;
})();

/** What's stored for a picture and checked against the others. */
export type PfpPrint = {
  grid: string[]; // a hash per WINDOWS entry, as 144-character strings of 0s and 1s
  mirror: string; // the mirrored picture's hash
  thumb: string; // base64 of THUMB x THUMB bytes
};

/** Couldn't read the picture: launches are refused rather than let an unchecked picture through. */
export class PfpError extends Error {}

/** A JPEG or PNG, by its first bytes, whatever the URL says. */
export function decodeImage(bytes: Uint8Array): Rgba {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const j = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 128 });
      return { width: j.width, height: j.height, data: j.data };
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const p = PNG.sync.read(Buffer.from(bytes));
      return { width: p.width, height: p.height, data: p.data };
    }
  } catch (e) {
    throw new PfpError(`undecodable image: ${(e as Error).message}`);
  }
  throw new PfpError("not a JPEG or PNG");
}

/** Averages an image into size x size greys, with transparency over white. */
function toGreys(img: Rgba, size: number): Greys {
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    const ya = Math.floor((y * img.height) / size);
    const yb = Math.max(ya + 1, Math.floor(((y + 1) * img.height) / size));
    for (let x = 0; x < size; x++) {
      const xa = Math.floor((x * img.width) / size);
      const xb = Math.max(xa + 1, Math.floor(((x + 1) * img.width) / size));
      let sum = 0;
      let n = 0;
      for (let j = ya; j < yb && j < img.height; j++) {
        for (let i = xa; i < xb && i < img.width; i++) {
          const o = (j * img.width + i) * 4;
          const a = img.data[o + 3] / 255;
          sum += (0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]) * a + 255 * (1 - a);
          n++;
        }
      }
      out[y * size + x] = n ? sum / n : 255;
    }
  }
  return out;
}

function mirrored(g: Greys, size: number): Greys {
  const out = new Float64Array(g.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) out[y * size + x] = g[y * size + size - 1 - x];
  }
  return out;
}

/** Sum of everything above and left of each point, so any window's cell averages cost the same. */
function summed(g: Greys, size: number): Float64Array {
  const s = new Float64Array((size + 1) * (size + 1));
  for (let y = 1; y <= size; y++) {
    for (let x = 1; x <= size; x++) {
      s[y * (size + 1) + x] = g[(y - 1) * size + x - 1] + s[(y - 1) * (size + 1) + x] + s[y * (size + 1) + x - 1] - s[(y - 1) * (size + 1) + x - 1];
    }
  }
  return s;
}

/** dHash of one window: is each cell brighter than the one to its left? */
function hashWindow(s: Float64Array, size: number, [wx, wy, wz]: Window): string {
  const row = size + 1;
  const cells = new Float64Array(HASH_W * HASH_H);
  for (let y = 0; y < HASH_H; y++) {
    const ya = Math.floor((wy + (y * wz) / HASH_H) * size);
    const yb = Math.max(ya + 1, Math.min(size, Math.floor((wy + ((y + 1) * wz) / HASH_H) * size)));
    for (let x = 0; x < HASH_W; x++) {
      const xa = Math.floor((wx + (x * wz) / HASH_W) * size);
      const xb = Math.max(xa + 1, Math.min(size, Math.floor((wx + ((x + 1) * wz) / HASH_W) * size)));
      cells[y * HASH_W + x] = (s[yb * row + xb] - s[ya * row + xb] - s[yb * row + xa] + s[ya * row + xa]) / ((yb - ya) * (xb - xa));
    }
  }
  let bits = "";
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W - 1; x++) bits += cells[y * HASH_W + x] < cells[y * HASH_W + x + 1] ? "1" : "0";
  }
  return bits;
}

const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export function printImage(bytes: Uint8Array): PfpPrint {
  const img = decodeImage(bytes);
  if (img.width < 1 || img.height < 1) throw new PfpError("empty image");
  const work = toGreys(img, WORK);
  const s = summed(work, WORK);
  return {
    grid: WINDOWS.map((w) => hashWindow(s, WORK, w)),
    mirror: hashWindow(summed(mirrored(work, WORK), WORK), WORK, WINDOWS[0]),
    thumb: toBase64(Uint8Array.from(toGreys(img, THUMB), (v) => Math.round(v))),
  };
}

/** The mirrored version of a stored thumb. */
export function mirrorThumb(thumb: string): string {
  return toBase64(Uint8Array.from(mirrored(Float64Array.from(fromBase64(thumb)), THUMB), (v) => Math.round(v)));
}

/**
 * How closely all of `part` matches `window` of `whole`, nudged a little either way: -1 to 1. Flat areas score 0, since a blank
 * area says nothing about whether two pictures are the same.
 */
export function correlation(whole: string, part: string, window: Window): number {
  const w = fromBase64(whole);
  const p = fromBase64(part);
  const S = Math.max(8, Math.round(window[2] * THUMB));
  const c = new Float64Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) c[y * S + x] = p[Math.min(THUMB - 1, Math.floor((y * THUMB) / S)) * THUMB + Math.min(THUMB - 1, Math.floor((x * THUMB) / S))];
  }
  let cMean = 0;
  for (const v of c) cMean += v;
  cMean /= c.length;
  let cVar = 0;
  for (const v of c) cVar += (v - cMean) ** 2;
  if (cVar / c.length < FLAT) return 0;

  const ox = Math.round(window[0] * THUMB);
  const oy = Math.round(window[1] * THUMB);
  let best = 0;
  for (let dy = -NUDGE; dy <= NUDGE; dy++) {
    for (let dx = -NUDGE; dx <= NUDGE; dx++) {
      const x0 = ox + dx;
      const y0 = oy + dy;
      if (x0 < 0 || y0 < 0 || x0 + S > THUMB || y0 + S > THUMB) continue;
      let mean = 0;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) mean += w[(y0 + y) * THUMB + x0 + x];
      }
      mean /= S * S;
      let wVar = 0;
      let both = 0;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const u = w[(y0 + y) * THUMB + x0 + x] - mean;
          wVar += u * u;
          both += u * (c[y * S + x] - cMean);
        }
      }
      if (wVar / (S * S) < FLAT) continue;
      const r = both / Math.sqrt(wVar * cVar);
      if (r > best) best = r;
    }
  }
  return best;
}

/** One way a picture might be a copy of a launched one, from the database: `w` indexes WINDOWS, from 1. */
export type PfpHit = {
  w: number;
  // crop: mine looks like a window of theirs. mirror: the same, mirrored. border: theirs looks like a window of mine.
  kind: "crop" | "mirror" | "border";
};

/** Step 2: is any of these hits really a copy? */
export function confirmsCopy(mine: string, theirs: string, hits: PfpHit[]): boolean {
  let mineMirrored: string | null = null;
  return hits.some(({ w, kind }) => {
    const window = WINDOWS[w - 1];
    if (!window) return false;
    if (kind === "border") return correlation(mine, theirs, window) >= PFP_CONFIRM;
    if (kind === "mirror") mineMirrored ??= mirrorThumb(mine);
    return correlation(theirs, kind === "mirror" ? mineMirrored! : mine, window) >= PFP_CONFIRM;
  });
}

/** X's stock avatars are shared by everyone who never set a picture, so they don't count as copies. */
export function isDefaultAvatar(url: string): boolean {
  return url.includes("default_profile");
}

/** Fetches a picture from one of `hosts` and prints it. */
export async function printPictureAt(url: string, hosts: string[]): Promise<PfpPrint> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PfpError("bad picture URL");
  }
  if (u.protocol !== "https:" || !hosts.includes(u.hostname)) throw new PfpError(`picture host not allowed: ${u.hostname}`);
  let res: Response;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(FETCH_MS), redirect: "error" });
  } catch (e) {
    throw new PfpError(`couldn't fetch picture: ${(e as Error).message}`);
  }
  if (!res.ok) throw new PfpError(`picture fetch failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new PfpError(`picture is ${bytes.length} bytes`);
  return printImage(bytes);
}
