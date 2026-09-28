// Node tests for supabase/functions/_shared (run: ./script/test-supabase.sh). Imports are rewritten from
// Deno's npm: specifiers to plain package names by the script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { curveTradeToRow, hlFillToRow, hlVenue, launchedToToken, pairSwapToRow } from "./indexer.ts";
import { canonicalProfile } from "./launchPass.ts";

const log = <A>(args: A) => ({ args, transactionHash: "0xabc" as const, logIndex: 3, blockNumber: 42n });
const T = "0x2000000000000000000000000000000000000002";
const W_HIGH = "0xf000000000000000000000000000000000000000"; // WHYPE sorts after the token -> token is token0
const W_LOW = "0x1000000000000000000000000000000000000000"; // WHYPE sorts first -> token is token1

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
    log({ token: T, trader: "0xAA", isBuy: false, hypeAmount: 2n * 10n ** 18n, tokenAmount: 5n * 10n ** 18n, fee: 10n ** 16n }),
    "2026-09-27T00:00:00.000Z",
    90,
  );
  assert.deepEqual([r.venue, r.side, r.quote_amount, r.size, r.usd_value, r.fee], ["curve", "sell", "2", "5", 180, "0.01"]);
});

test("pair swap orientation (token0 and token1)", () => {
  const e = 10n ** 18n;
  // buy: 1 HYPE in, 1000 tokens out
  const buy0 = pairSwapToRow(log({ amount0In: 0n, amount1In: e, amount0Out: 1000n * e, amount1Out: 0n }), T, W_HIGH, "0xF", "t", 90);
  assert.deepEqual([buy0.side, buy0.quote_amount, buy0.size, buy0.usd_value], ["buy", "1", "1000", 90]);
  const buy1 = pairSwapToRow(log({ amount0In: e, amount1In: 0n, amount0Out: 0n, amount1Out: 1000n * e }), T, W_LOW, "0xF", "t", 90);
  assert.deepEqual([buy1.side, buy1.quote_amount, buy1.size], ["buy", "1", "1000"]);
  // sell: 500 tokens in, 0.5 HYPE out
  const sell0 = pairSwapToRow(log({ amount0In: 500n * e, amount1In: 0n, amount0Out: 0n, amount1Out: e / 2n }), T, W_HIGH, "0xF", "t", null);
  assert.deepEqual([sell0.side, sell0.quote_amount, sell0.size, sell0.usd_value], ["sell", "0.5", "500", null]);
});

test("launched -> token row", () => {
  const r = launchedToToken(
    log({ token: T, creator: "0xCC", xUserId: 1850000000000000123n, handle: "Von_Builds9", category: 2, profileHash: "0x11" }),
    "t",
  );
  assert.deepEqual([r.x_user_id, r.symbol, r.category, r.creator], ["1850000000000000123", "VON_BUILDS9", "researcher", "0xcc"]);
});

test("profile validation + stable hash", () => {
  const who = { xUserId: "1", handle: "a", category: "trader" as const };
  assert.throws(() => canonicalProfile({ about: "too short" }, who), /at least 50/);
  assert.throws(() => canonicalProfile({ about: "x".repeat(60), links: [{ label: "p", url: "http://x.com" }] }, who), /https/);
  const a = canonicalProfile({ about: "  " + "y".repeat(60) + " ", links: [{ label: " P ", url: "https://x.com/a" }] }, who);
  const b = canonicalProfile({ about: "y".repeat(60), links: [{ label: "P", url: "https://x.com/a" }] }, who);
  assert.equal(a.hash, b.hash);
});
