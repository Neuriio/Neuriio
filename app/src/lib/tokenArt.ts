// Token art on Ascend (user, 2026-11-08: creators must never have to leave Neuriio to set their picture). Ascend keeps each
// coin's picture, description and links off-chain, owned by the coin's creator-fee recipient (for our launches: the creator's
// Neuriio wallet). Two silent signatures from that wallet, exactly as Ascend's own app does it (their TokenPage, 2026-11-04):
//   1. "Ascend token art v2" message -> POST api.ascendlaunch.xyz/v1/metadata (multipart: the image, the fields, creator,
//      chainId, expires, signature, and a Turnstile token from Ascend's site key; that key works on app.neuriio.xyz only, and
//      the upload must come from the user's browser, not a server) -> metadataCid + imageCid, pinned to IPFS by Ascend
//   2. "Ascend token metadata" message -> POST /v1/tokens/<token>/metadata {chainId, metadataCid, creator, signature}; 202 =
//      saved but not verified yet (their indexer), retried a few times
// A creator's first attachment is FINAL for them on Ascend (they can't overwrite it), so the window says so before signing.
import type { Address } from "viem";

export const ASCEND_API = "https://api.ascendlaunch.xyz";
export const ASCEND_TURNSTILE_SITE_KEY = "0x4AAAAAAAFxMC7ihfVklbm6g"; // Ascend's, for app.neuriio.xyz (rook, 2026-11-08)
export const ART_LIMITS = { name: 40, symbol: 10, description: 500, website: 200, imageBytes: 2 * 1024 * 1024 }; // Ascend's
export const ART_HOST = "app.neuriio.xyz"; // the only place Ascend's Turnstile key works (localhost doesn't)

export type ArtFields = { name: string; symbol: string; description: string; website: string | null; twitter: string | null; telegram: string | null };
export type Pinned = { metadataCid: string; imageCid: string; metadataUri: string; imageUri: string };
export type CurrentArt = { creator: string; verified: boolean; imageUri: string | null } | null;

const clean = (v: string | null | undefined) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "");

/** Ascend's own field rules (their validator, same order and messages): the fields to sign and send, or an error. */
export function artFields(input: { name: string; symbol: string; description?: string; website?: string; twitter?: string; telegram?: string }):
  | { ok: true; fields: ArtFields }
  | { ok: false; error: string } {
  const name = clean(input.name);
  if (!name || name.length > ART_LIMITS.name) return { ok: false, error: `The name must be 1 to ${ART_LIMITS.name} characters.` };
  const symbol = clean(input.symbol);
  if (!/^[^\p{Cc}]+$/u.test(symbol)) return { ok: false, error: "The ticker is missing." };
  const description = clean(input.description);
  if (description.length > ART_LIMITS.description) return { ok: false, error: `The description can be at most ${ART_LIMITS.description} characters.` };
  let website: string | null = null;
  const w = clean(input.website);
  if (w) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`);
    } catch {
      return { ok: false, error: "The website isn't a link." };
    }
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return { ok: false, error: "The website must be an https link." };
    website = url.toString();
    if (website.length > ART_LIMITS.website) return { ok: false, error: `The website can be at most ${ART_LIMITS.website} characters.` };
  }
  const twitter = clean(input.twitter).replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//i, "");
  if (twitter && !/^[A-Za-z0-9_]{1,15}$/.test(twitter)) return { ok: false, error: "X must be a handle." };
  const telegram = clean(input.telegram).replace(/^@/, "").replace(/^https?:\/\/t\.me\//i, "");
  if (telegram && !/^[A-Za-z0-9_]{5,32}$/.test(telegram)) return { ok: false, error: "Telegram must be a handle or group name." };
  return { ok: true, fields: { name, symbol, description, website, twitter: twitter || null, telegram: telegram || null } };
}

/** Message 1, byte for byte as Ascend builds it. */
export function artMessage(a: ArtFields & { creator: string; chainId: number; imageSha256: string; expires: number }) {
  return [
    "Ascend token art v2",
    `creator: ${a.creator.toLowerCase()}`,
    `chain: ${a.chainId}`,
    `name: ${JSON.stringify(a.name)}`,
    `symbol: ${JSON.stringify(a.symbol)}`,
    `description: ${JSON.stringify(a.description)}`,
    `website: ${JSON.stringify(a.website)}`,
    `twitter: ${JSON.stringify(a.twitter)}`,
    `telegram: ${JSON.stringify(a.telegram)}`,
    `image: ${a.imageSha256}`,
    `expires: ${a.expires}`,
  ].join("\n");
}

/** Message 2, byte for byte as Ascend builds it. */
export function claimMessage(a: { chainId: number; token: string; metadataCid: string }) {
  return ["Ascend token metadata", `chain: ${a.chainId}`, `token: ${a.token.toLowerCase()}`, `metadata: ipfs://${a.metadataCid}`].join("\n");
}

export async function sha256Hex(bytes: ArrayBuffer) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** PNG, JPEG, GIF or WebP under 2 MB (Ascend's limits), checked by the file's first bytes. Null = fine. */
export async function imageProblem(file: Blob) {
  if (file.size > ART_LIMITS.imageBytes) return "The picture must be under 2 MB.";
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  const ok = (b[0] === 0x89 && at(1, "PNG")) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || at(0, "GIF8") || (at(0, "RIFF") && at(8, "WEBP"));
  return ok ? null : "The picture must be a PNG, JPEG, GIF or WebP.";
}

async function apiError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `${fallback} (${res.status})`);
}

/** The coin's art on Ascend now, or null if it has none. */
export async function currentArt(token: string): Promise<CurrentArt> {
  const res = await fetch(`${ASCEND_API}/v1/tokens/${token.toLowerCase()}/metadata`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Couldn't check the current picture. Try again.");
  const j = (await res.json()) as { creator: string; verified: boolean; imageUri?: string | null };
  return { creator: j.creator, verified: j.verified, imageUri: j.imageUri ?? null };
}

/** Step 1: pins the image and fields through Ascend. */
export async function pinArt(a: { file: Blob; fileName: string; fields: ArtFields; creator: Address; chainId: number; expires: number; signature: string; turnstile: string }): Promise<Pinned> {
  const form = new FormData();
  form.set("file", a.file, a.fileName || "image");
  for (const k of ["name", "symbol", "description", "website", "twitter", "telegram"] as const) form.set(k, a.fields[k] ?? "");
  form.set("creator", a.creator);
  form.set("chainId", String(a.chainId));
  form.set("expires", String(a.expires));
  form.set("signature", a.signature);
  form.set("turnstile", a.turnstile);
  const res = await fetch(`${ASCEND_API}/v1/metadata`, { method: "POST", body: form });
  if (!res.ok) return apiError(res, "Pinning the picture failed");
  return (await res.json()) as Pinned;
}

/** Step 2: attaches the pinned art to the coin. True once Ascend has verified it (it may take a minute after a launch). */
export async function claimArt(token: string, body: { chainId: number; metadataCid: string; creator: Address; signature: string }, tries = 4) {
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 4_000));
    const res = await fetch(`${ASCEND_API}/v1/tokens/${token.toLowerCase()}/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 200) return true;
    if (res.ok) continue; // 202: saved, verification pending
    if (res.status === 429 || res.status === 503) continue;
    await apiError(res, "Attaching the picture failed");
  }
  return false;
}
