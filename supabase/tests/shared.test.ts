// Node tests for supabase/functions/_shared (run: ./script/test-supabase.sh). Imports are rewritten from
// Deno's npm: specifiers to plain package names by the script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { curveTradeToRow, ftfLaunchedToToken, hlFillToRow, hlVenue, launchedToToken, pairSwapToRow, poolPrice } from "./indexer.ts";
import { Buffer } from "node:buffer";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { canonicalFtfProfile, canonicalProfile, chainCategory, tickerPrefix, validFtfIdentity } from "./launchPass.ts";
import { claimLaunch } from "./launchClaim.ts";
import { confirmsCopy, correlation, isDefaultAvatar, mirrorThumb, PFP_CONFIRM, PFP_HASH_BITS, PfpError, printImage, printPictureAt, WINDOWS } from "./pfpHash.ts";

const log = <A>(args: A) => ({ args, address: "0xPAD", transactionHash: "0xabc" as const, logIndex: 3, blockNumber: 42n });
const T = "0x2000000000000000000000000000000000000002";
const W_HIGH = "0xf000000000000000000000000000000000000000"; // WHYPE sorts after the token -> token is token0
const W_LOW = "0x1000000000000000000000000000000000000000"; // WHYPE sorts first -> token is token1
// the old HYPE world (18 decimals, USD from HYPE's price) and the USDC world (6 decimals, $1)
const hype = (address: string, usd: number | null) => ({ address, decimals: 18, usd });
const USDC_HIGH = { address: W_HIGH, decimals: 6, usd: 1 };

test("hlVenue", () => {
  assert.equal(hlVenue("BTC"), "hl_perp");
  assert.equal(hlVenue("xyz:AAPL"), "hl_perp");
  assert.equal(hlVenue("@107"), "hl_spot");
  assert.equal(hlVenue("PURR/USDC"), "hl_spot");
  assert.equal(hlVenue("#1230"), "hl_outcome");
});

test("only builder-fee fills count", () => {
  const base = { coin: "BTC", px: "100000", sz: "0.01", side: "B" as const, time: 1_790_000_000_000, fee: "0.45", tid: 7 };
  assert.equal(hlFillToRow(base, "0xAbC"), null);
  assert.equal(hlFillToRow({ ...base, builderFee: "0" }, "0xAbC"), null);
  const r = hlFillToRow({ ...base, builderFee: "0.001" }, "0xAbC")!;
  assert.equal(r.venue, "hl_perp");
  assert.equal(r.usd_value, 1000);
  assert.equal(r.side, "buy");
  assert.equal(r.trader, "0xabc");
  assert.equal(r.hl_tid, 7);
});

test("curve trade -> row with USD", () => {
  const r = curveTradeToRow(
    log({ token: T, trader: "0xAA", isBuy: false, hypeAmount: 2n * 10n ** 18n, tokenAmount: 5n * 10n ** 18n, fee: 10n ** 16n, virtualHype: 10n ** 18n, virtualToken: 10n ** 27n }),
    "2026-09-27T00:00:00.000Z",
    hype(W_HIGH, 90),
  );
  assert.deepEqual([r.venue, r.side, r.quote_amount, r.size, r.usd_value, r.fee], ["curve", "sell", "2", "5", 180, "0.01"]);
});

test("curve trade -> spot price + curve progress", () => {
  const e = 10n ** 18n;
  // 60 HYPE virtual at launch; after 100M tokens sold: virtualToken = 973M, virtualHype = 60 * 1073 / 973
  const r = curveTradeToRow(
    log({
      token: T, trader: "0xAA", isBuy: true, hypeAmount: e, tokenAmount: e, fee: 0n,
      virtualHype: 66n * e, virtualToken: 973_000_000n * e,
    }),
    "t",
    hype(W_HIGH, null),
  );
  assert.equal(r.curve_sold, "100000000");
  assert.ok(Math.abs(Number(r.price_hype) / (66 / 973_000_000) - 1) < 1e-15);
});

test("pool price from Sync reserves (either token order)", () => {
  const e = 10n ** 18n;
  // 170 HYPE vs 206.9M tokens
  assert.ok(Math.abs(Number(poolPrice(206_900_000n * e, 170n * e, T, hype(W_HIGH, null))) / (170 / 206_900_000) - 1) < 1e-15); // token is token0
  assert.ok(Math.abs(Number(poolPrice(170n * e, 206_900_000n * e, T, hype(W_LOW, null))) / (170 / 206_900_000) - 1) < 1e-15); // token is token1
});

test("pair swap orientation (token0 and token1)", () => {
  const e = 10n ** 18n;
  // buy: 1 HYPE in, 1000 tokens out
  const buy0 = pairSwapToRow(log({ amount0In: 0n, amount1In: e, amount0Out: 1000n * e, amount1Out: 0n }), T, hype(W_HIGH, 90), "0xF", "t");
  assert.deepEqual([buy0.side, buy0.quote_amount, buy0.size, buy0.usd_value], ["buy", "1", "1000", 90]);
  const buy1 = pairSwapToRow(log({ amount0In: e, amount1In: 0n, amount0Out: 0n, amount1Out: 1000n * e }), T, hype(W_LOW, 90), "0xF", "t");
  assert.deepEqual([buy1.side, buy1.quote_amount, buy1.size], ["buy", "1", "1000"]);
  // sell: 500 tokens in, 0.5 HYPE out
  const sell0 = pairSwapToRow(log({ amount0In: 500n * e, amount1In: 0n, amount0Out: 0n, amount1Out: e / 2n }), T, hype(W_HIGH, null), "0xF", "t");
  assert.deepEqual([sell0.side, sell0.quote_amount, sell0.size, sell0.usd_value], ["sell", "0.5", "500", null]);
});

test("USDC world: 6-decimal amounts, $1 per USDC, prices per whole token", () => {
  const e = 10n ** 18n;
  // 5,000 USDC virtual : 1.073B tokens; a 100 USDC buy (1 USDC fee) through the router, trader from CurveTraded
  const r = curveTradeToRow(
    log({ token: T, trader: "0xRouter", isBuy: true, hypeAmount: 100_000_000n, tokenAmount: 20_000_000n * e, fee: 1_000_000n, virtualHype: 5_100_000_000n, virtualToken: 1_053_000_000n * e }),
    "t",
    USDC_HIGH,
    "0xTrader",
  );
  assert.deepEqual([r.trader, r.quote_amount, r.usd_value, r.fee, r.size], ["0xtrader", "100", 100, "1", "20000000"]);
  assert.ok(Math.abs(Number(r.price_hype) / (5100 / 1_053_000_000) - 1) < 1e-15, "USDC per whole token");
  // pool: 2,834 USDC vs 206.9M tokens (token is token0)
  assert.ok(Math.abs(Number(poolPrice(206_900_000n * e, 2_834_000_000n, T, USDC_HIGH)) / (2834 / 206_900_000) - 1) < 1e-15);
  const sell = pairSwapToRow(log({ amount0In: 1000n * e, amount1In: 0n, amount0Out: 0n, amount1Out: 13_500_000n }), T, USDC_HIGH, "0xF", "t");
  assert.deepEqual([sell.side, sell.quote_amount, sell.usd_value], ["sell", "13.5", 13.5]);
  const tok = launchedToToken(
    log({ token: T, creator: "0xCC", xUserId: 1n, handle: "dog", category: 0, profileHash: "0x11", virtualHype: 1_000_000_000n }),
    "t",
    USDC_HIGH,
  );
  assert.equal(tok.virtual_hype, "1000", "1,000 USDC virtual reserve");
});

test("launched -> token row", () => {
  const r = launchedToToken(
    log({ token: T, creator: "0xCC", xUserId: 1850000000000000123n, handle: "Von_Builds9", category: 2, profileHash: "0x11", virtualHype: 60n * 10n ** 18n }),
    "t",
    hype(W_HIGH, null),
  );
  assert.deepEqual([r.x_user_id, r.symbol, r.category, r.creator, r.virtual_hype], ["1850000000000000123", "VON_BUILDS9", "researcher", "0xcc", "60"]);
  assert.equal(r.launchpad, "0xpad", "tagged with the Launchpad version that launched it");
});

test("profile validation + stable hash", () => {
  const who = { xUserId: "1", handle: "a", category: "trader" as const };
  assert.throws(() => canonicalProfile({ about: "too short" }, who), /at least 50/);
  assert.throws(() => canonicalProfile({ about: "x".repeat(60), links: [{ label: "p", url: "http://x.com" }] }, who), /https/);
  const a = canonicalProfile({ about: "  " + "y".repeat(60) + " ", links: [{ label: " P ", url: "https://x.com/a" }] }, who);
  const b = canonicalProfile({ about: "y".repeat(60), links: [{ label: "P", url: "https://x.com/a" }] }, who);
  assert.equal(a.hash, b.hash);
});

test("categories past the launcher's enum go on-chain as their nearest, and stay exact in the profile", () => {
  const onChain = ["trader", "meme_trader", "researcher", "influencer", "builder", "creator"] as const;
  onChain.forEach((c, i) => assert.equal(chainCategory(c), i)); // the order of the frozen Category enum
  assert.equal(chainCategory("meme_account"), 5);
  assert.equal(chainCategory("founders"), 4);
  const p = canonicalProfile({ about: "y".repeat(60) }, { xUserId: "1", handle: "a", category: "founders" });
  assert.match(p.content, /"category":"founders"/);
});

test("profile: the first link is always their own X account, and nothing can stand in for it", () => {
  const who = { xUserId: "1", handle: "ElonMusk", category: "trader" as const };
  const about = "y".repeat(60);
  const linksOf = (links?: { label: string; url: string }[]) => JSON.parse(canonicalProfile({ about, links }, who).content).links;
  const x = { label: "X", url: "https://x.com/elonmusk" };
  assert.deepEqual(linksOf(), [x]);
  assert.deepEqual(linksOf([x]), [x]);
  assert.deepEqual(linksOf([{ label: "Mine", url: "https://x.com/ElonMusk/" }]), [x]); // sent again under another name: one copy
  assert.deepEqual(linksOf([{ label: "Site", url: "https://a.com/" }]), [x, { label: "Site", url: "https://a.com/" }]);
  assert.deepEqual(linksOf([{ label: "Site", url: "https://a.com/" }, x]), [x, { label: "Site", url: "https://a.com/" }]);
  assert.deepEqual(linksOf([{ label: "A post", url: "https://x.com/someone/status/1" }])[1].label, "A post"); // other X pages are fine
  for (const label of ["X", "x", " Twitter "]) {
    assert.throws(() => linksOf([{ label, url: "https://x.com/impostor" }]), /added automatically/);
  }
  const site = (i: number) => ({ label: `S${i}`, url: `https://a.com/${i}` });
  assert.equal(linksOf(Array.from({ length: 9 }, (_, i) => site(i))).length, 10);
  assert.throws(() => linksOf(Array.from({ length: 10 }, (_, i) => site(i))), /At most 10/);
  assert.equal(linksOf([x, ...Array.from({ length: 9 }, (_, i) => site(i))]).length, 10);
});

test("profile: link list is capped before any per-link work", () => {
  const who = { xUserId: "1", handle: "a", category: "trader" as const };
  const many = Array.from({ length: 100_000 }, () => ({ label: "x", url: "https://x.com" }));
  assert.throws(() => canonicalProfile({ about: "y".repeat(60), links: many }, who), /At most 10 links/);
  assert.throws(() => canonicalProfile({ about: "y".repeat(60), links: "nope" as never }, who), /must be a list/);
});

test("FTF launched -> token row (4 members, ticker as handle)", () => {
  const r = ftfLaunchedToToken(
    log({ token: T, founder: "0xF0", name: "Degen Den", ticker: "DEN", memberXIds: [1n, 2n, 3n, 4n], profileHash: "0x22", virtualHype: 60n * 10n ** 18n }),
    "t",
    hype(W_HIGH, null),
  );
  assert.deepEqual([r.kind, r.name, r.symbol, r.handle, r.x_user_id, r.category, r.creator], ["ftf", "Degen Den", "DEN", "den", null, null, "0xf0"]);
  assert.deepEqual(r.member_x_user_ids, ["1", "2", "3", "4"]);
});

test("FTF name + ticker rules match the contract", () => {
  assert.deepEqual(validFtfIdentity(" Degen Den ", "den"), { name: "Degen Den", ticker: "DEN" });
  for (const bad of ["", "De  n", "Den<script>", "x".repeat(33)]) assert.throws(() => validFtfIdentity(bad, "DEN"), /Name/);
  for (const bad of ["D", "DEN!", "ABCDEFGHIJK"]) assert.throws(() => validFtfIdentity("Degen Den", bad), /Ticker/);
  const a = canonicalFtfProfile({ about: "z".repeat(60) }, { name: "Degen Den", ticker: "DEN", founderXUserId: "1", category: "trader", pfpUrl: null });
  assert.match(a.content, /"category":"trader"/);
  assert.doesNotMatch(a.content, /sector/);
  assert.match(a.content, /"kind":"ftf"/);
});

// ------------------------------------------------------------------ anti-vamping

test("tickerPrefix: the first 4 characters, ignoring case and symbols, with 0 as O and 1 as I", () => {
  assert.equal(tickerPrefix("elonmusk"), "ELON");
  assert.equal(tickerPrefix("ELONMUSK"), "ELON");
  assert.equal(tickerPrefix("_elon_"), "ELON");
  assert.equal(tickerPrefix("el0n"), "ELON");
  assert.equal(tickerPrefix("e_l_o_n_x"), "ELON");
  assert.equal(tickerPrefix("pep3"), "PEP3"); // only 0 and 1 are read as letters
  assert.equal(tickerPrefix("1nch"), "INCH");
  assert.equal(tickerPrefix("ab"), "AB");
  assert.equal(tickerPrefix("0xabcd"), "OXAB");
});

/** A picture with real structure: soft blobs, different per seed, so its hash means something. */
function picture(seed: number, size = 200) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 128 + 60 * Math.sin((x * (seed + 2)) / 37 + seed) + 60 * Math.cos((y * (seed + 3)) / 41 + seed * 2);
      const o = (y * size + x) * 4;
      data[o] = v;
      data[o + 1] = 255 - v;
      data[o + 2] = (v + seed * 40) % 255;
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}
type Pic = ReturnType<typeof picture>;
const asJpeg = (p: Pic, quality = 90) => new Uint8Array(jpeg.encode({ ...p, data: Buffer.from(p.data) }, quality).data);
const asPng = (p: Pic) => {
  const png = new PNG({ width: p.width, height: p.height });
  png.data = Buffer.from(p.data);
  return new Uint8Array(PNG.sync.write(png));
};
const cropped = (p: Pic, fx: number, fy: number, fz: number): Pic => {
  const x0 = Math.floor(fx * p.width);
  const y0 = Math.floor(fy * p.height);
  const w = Math.floor(fz * p.width);
  const data = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) data[(y * w + x) * 4 + c] = p.data[((y0 + y) * p.width + x0 + x) * 4 + c];
  }
  return { width: w, height: w, data: data as Pic["data"] };
};
const flippedOf = (p: Pic): Pic => {
  const data = new Uint8Array(p.data.length);
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) for (let c = 0; c < 4; c++) data[(y * p.width + x) * 4 + c] = p.data[(y * p.width + p.width - 1 - x) * 4 + c];
  }
  return { ...p, data: data as Pic["data"] };
};
const bitsApart = (a: string, b: string) => [...a].filter((c, i) => c !== b[i]).length;
/** What the database does: the closest windows of `theirs` to `mine`. */
const closest = (mine: string, grid: string[], n = 5) =>
  grid.map((h, i) => ({ w: i + 1, d: bitsApart(h, mine) })).filter((x) => x.d <= PFP_HASH_BITS).sort((a, b) => a.d - b.d).slice(0, n);

test("picture print: its shape", () => {
  const p = printImage(asJpeg(picture(1)));
  assert.equal(p.grid.length, WINDOWS.length);
  assert.equal(p.grid[0].length, 144);
  assert.equal(p.mirror.length, 144);
  assert.equal(Buffer.from(p.thumb, "base64").length, 64 * 64);
  assert.deepEqual(WINDOWS[0], [0, 0, 1]);
  assert.ok(WINDOWS.every(([x, y, z]) => x >= 0 && y >= 0 && x + z <= 1.000001 && y + z <= 1.000001));
});

test("picture match: a re-compressed copy, in either format", () => {
  const p = picture(1);
  const original = printImage(asJpeg(p));
  for (const copy of [printImage(asJpeg(p, 40)), printImage(asPng(p))]) {
    const hits = closest(copy.grid[0], original.grid).map((h) => ({ w: h.w, kind: "crop" as const }));
    assert.ok(confirmsCopy(copy.thumb, original.thumb, hits));
  }
});

test("picture match: cropped copies, at every size down to half", () => {
  const p = picture(4);
  const original = printImage(asPng(p));
  for (const [x, y, z] of [[0.02, 0.03, 0.95], [0.1, 0.05, 0.85], [0.2, 0.1, 0.7], [0.05, 0.25, 0.6], [0.3, 0.3, 0.5]]) {
    const copy = printImage(asJpeg(cropped(p, x, y, z), 60));
    const hits = closest(copy.grid[0], original.grid).map((h) => ({ w: h.w, kind: "crop" as const }));
    assert.ok(hits.length > 0, `no hash hit keeping ${z}`);
    assert.ok(confirmsCopy(copy.thumb, original.thumb, hits), `not confirmed keeping ${z}`);
  }
});

test("picture match: mirrored copies", () => {
  const p = picture(2);
  const original = printImage(asPng(p));
  const copy = printImage(asPng(flippedOf(p)));
  assert.equal(bitsApart(copy.mirror, original.grid[0]), 0);
  const hits = closest(copy.mirror, original.grid).map((h) => ({ w: h.w, kind: "mirror" as const }));
  assert.ok(confirmsCopy(copy.thumb, original.thumb, hits));
  assert.ok(!confirmsCopy(copy.thumb, original.thumb, [{ w: 1, kind: "crop" }]));
});

test("picture match: a launched picture inside a bigger one (a border added)", () => {
  const p = picture(5);
  const inner = cropped(p, 0.15, 0.15, 0.7); // "theirs" is what's left, "mine" has more around it
  const mine = printImage(asPng(p));
  const theirs = printImage(asPng(inner));
  const hits = closest(theirs.grid[0], mine.grid).map((h) => ({ w: h.w, kind: "border" as const }));
  assert.ok(hits.length > 0);
  assert.ok(confirmsCopy(mine.thumb, theirs.thumb, hits));
});

test("picture match: different pictures don't confirm, even on every window", () => {
  // patchworks, not picture(): those are all smooth waves, which really do resemble each other
  const patchwork = (seed: number) => {
    const size = 160;
    const data = new Uint8Array(size * size * 4).fill(255);
    let r = seed * 2654435761;
    const cells = Array.from({ length: 100 }, () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) >>> 24);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) data.fill(cells[Math.floor(y / 16) * 10 + Math.floor(x / 16)], (y * size + x) * 4, (y * size + x) * 4 + 3);
    }
    return { width: size, height: size, data: data as Pic["data"] };
  };
  const prints = [1, 2, 3, 4, 5, 6].map((s) => printImage(asPng(patchwork(s))));
  for (let i = 0; i < prints.length; i++) {
    for (let j = 0; j < prints.length; j++) {
      if (i === j) continue;
      const hits = closest(prints[i].grid[0], prints[j].grid, 20).map((h) => ({ w: h.w, kind: "crop" as const }));
      assert.ok(!confirmsCopy(prints[i].thumb, prints[j].thumb, hits), `${i} vs ${j}`);
    }
  }
});

test("picture match: blank pictures and blank areas say nothing", () => {
  const blank = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(255) };
  const a = printImage(asPng(blank));
  const b = printImage(asPng(blank));
  assert.equal(correlation(a.thumb, b.thumb, WINDOWS[0]), 0);
  assert.ok(!confirmsCopy(a.thumb, b.thumb, [{ w: 1, kind: "crop" }]));
  const pic = printImage(asPng(picture(1)));
  assert.ok(!confirmsCopy(a.thumb, pic.thumb, [{ w: 1, kind: "crop" }]));
  assert.ok(!confirmsCopy(pic.thumb, a.thumb, [{ w: 1, kind: "crop" }]));
});

test("picture match: a window the database can't have sent is ignored", () => {
  const pic = printImage(asPng(picture(1)));
  assert.ok(!confirmsCopy(pic.thumb, pic.thumb, [{ w: 0, kind: "crop" }, { w: WINDOWS.length + 1, kind: "crop" }]));
  assert.ok(confirmsCopy(pic.thumb, pic.thumb, [{ w: 1, kind: "crop" }]));
  assert.ok(PFP_CONFIRM > 0.74); // above what different real pictures reached
});

test("mirrorThumb twice is the original", () => {
  const { thumb } = printImage(asPng(picture(3)));
  assert.notEqual(mirrorThumb(thumb), thumb);
  assert.equal(mirrorThumb(mirrorThumb(thumb)), thumb);
});

test("picture print: anything but a JPEG or PNG is refused", () => {
  assert.throws(() => printImage(Uint8Array.from([0x42, 0x4d, 1, 2])), PfpError); // BMP
  assert.throws(() => printImage(new TextEncoder().encode("RIFFxxxxWEBP")), PfpError);
  assert.throws(() => printImage(Uint8Array.from([0xff, 0xd8, 0, 0])), PfpError); // a broken JPEG
  assert.throws(() => printImage(Uint8Array.from([0x89, 0x50, 0, 0])), PfpError); // a broken PNG
});

test("X's stock avatars don't count", () => {
  assert.ok(isDefaultAvatar("https://abs.twimg.com/sticky/default_profile_images/default_profile_200x200.png"));
  assert.ok(!isDefaultAvatar("https://pbs.twimg.com/profile_images/1/abc_200x200.jpg"));
});

test("printPictureAt only fetches from allowed hosts, over https", async () => {
  const real = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response(asJpeg(picture(1)));
  }) as typeof fetch;
  try {
    await assert.rejects(printPictureAt("https://evil.example/a.jpg", ["pbs.twimg.com"]), PfpError);
    await assert.rejects(printPictureAt("http://pbs.twimg.com/a.jpg", ["pbs.twimg.com"]), PfpError);
    await assert.rejects(printPictureAt("not a url", ["pbs.twimg.com"]), PfpError);
    assert.equal(fetched, 0);
    assert.equal((await printPictureAt("https://pbs.twimg.com/a.jpg", ["pbs.twimg.com"])).grid.length, WINDOWS.length);
    assert.equal(fetched, 1);
    globalThis.fetch = (async () => new Response("gone", { status: 404 })) as typeof fetch;
    await assert.rejects(printPictureAt("https://pbs.twimg.com/a.jpg", ["pbs.twimg.com"]), PfpError);
    globalThis.fetch = (async () => new Response(new Uint8Array(5_000_001))) as typeof fetch;
    await assert.rejects(printPictureAt("https://pbs.twimg.com/a.jpg", ["pbs.twimg.com"]), PfpError);
  } finally {
    globalThis.fetch = real;
  }
});

test("claimLaunch: turns the database's answer into a decision, and sends the right fields", async () => {
  const mine = printImage(asPng(picture(1)));
  const other = printImage(asPng(picture(2)));
  const calls: Record<string, unknown>[] = [];
  const deleted: unknown[] = [];
  const db = (answer: unknown) => ({
    rpc: async (_: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: answer, error: null };
    },
    from: () => ({ delete: () => ({ eq: async (_: string, id: unknown) => (deleted.push(id), { error: null }) }) }),
  }) as never;
  const claim = { ticker: "elonx", owners: ["1"], pfp: mine, deadline: new Date(0) };
  assert.equal(await claimLaunch(db({ conflict: null, claim: 7, suspects: [] }), claim), null);
  assert.match((await claimLaunch(db({ conflict: "ticker", with: "ELONMUSK" }), claim))!, /\$ELONX is too close to \$ELONMUSK/);
  assert.equal(calls[0].p_commit, true);
  assert.equal(calls[0].p_max_bits, PFP_HASH_BITS);
  assert.equal(calls[0].p_grid, mine.grid);
  assert.deepEqual(deleted, []);

  // a suspect that isn't a real copy lets the launch through and keeps the claim
  const hit = [{ w: 1, kind: "crop" }];
  assert.equal(await claimLaunch(db({ conflict: null, claim: 8, suspects: [{ ticker: "OTHER", thumb: other.thumb, hits: hit }] }), claim), null);
  assert.deepEqual(deleted, []);
  // a real copy is refused and its claim released
  assert.match(
    (await claimLaunch(db({ conflict: null, claim: 9, suspects: [{ ticker: "ELONMUSK", thumb: mine.thumb, hits: hit }] }), claim))!,
    /matches \$ELONMUSK/,
  );
  assert.deepEqual(deleted, [9]);

  await claimLaunch(db({ conflict: null, suspects: [] }), { ...claim, pfp: null, commit: false });
  assert.equal(calls[calls.length - 1].p_commit, false);
  assert.equal(calls[calls.length - 1].p_grid, null);
  const broken = { rpc: async () => ({ data: null, error: { message: "boom" } }) } as never;
  await assert.rejects(claimLaunch(broken, claim), /boom/);
});

// ------------------------------------------------------------------ referral codes
test("referral: codes, and the Verify message matches the app's word for word", async () => {
  const { isCode, normalizeCode, verifyMessage } = await import("./referral.ts");
  assert.equal(normalizeCode("  hyperx "), "HYPERX");
  assert.ok(isCode("HYPER_X1"));
  for (const bad of ["AB", "HYPER-X", "hyperx", "A".repeat(21), "HYPER X"]) assert.ok(!isCode(bad), bad);
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../../app/src/lib/referral.ts", import.meta.url), "utf8");
  const template = (src: string) => src.match(/export const verifyMessage = [^`]*(`[^`]*`)/)![1];
  const shared = readFileSync(new URL("../../supabase/functions/_shared/referral.ts", import.meta.url), "utf8");
  assert.equal(template(app), template(shared));
  assert.ok(verifyMessage("HYPERX", "0xA", "0xB").includes("0xB and want its trades counted for referral code HYPERX on the Neuriio account 0xA"));
});

test("referral: a Verify signature checks out only for the wallet, code and account it was made for", async () => {
  const { verifyMessage } = await import("./referral.ts");
  const { verifyMessage: check } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
  const account = "0x1111111111111111111111111111111111111111";
  const signature = await owner.signMessage({ message: verifyMessage("HYPERX", account, owner.address) });
  assert.ok(await check({ address: owner.address, message: verifyMessage("HYPERX", account, owner.address), signature }));
  assert.ok(!(await check({ address: other.address, message: verifyMessage("HYPERX", account, other.address), signature })));
  assert.ok(!(await check({ address: owner.address, message: verifyMessage("OTHER", account, owner.address), signature })));
  assert.ok(!(await check({ address: owner.address, message: verifyMessage("HYPERX", "0x2222222222222222222222222222222222222222", owner.address), signature })));
});
