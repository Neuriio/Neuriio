import { test } from "node:test";
import assert from "node:assert/strict";
import { liveTrades } from "../src/watch/trades.mjs";

const e = 10n ** 18n;
const PAD = "0x00000000000000000000000000000000000000aa";
const ROUTER = "0x00000000000000000000000000000000000000bb";
const TOKEN = "0x2000000000000000000000000000000000000002";
const WHYPE = "0xf000000000000000000000000000000000000000"; // sorts after TOKEN -> token is token0
const PAIR = "0x00000000000000000000000000000000000000cc";
const ctx = { launchpad: PAD, router: ROUTER, whype: WHYPE, pairToken: new Map([[PAIR, TOKEN]]) };
const log = (address, eventName, args, logIndex, tx = "0x01") => ({ address, eventName, args, logIndex, transactionHash: tx, blockNumber: 7n });
const close = (a, b) => assert.ok(Math.abs(a / b - 1) < 1e-12, `${a} vs ${b}`);

test("curve trade: price from virtual reserves", () => {
  const { trades } = liveTrades(
    [log(PAD, "Trade", { token: TOKEN, trader: "0xAB", isBuy: true, hypeAmount: e, tokenAmount: 1000n * e, fee: 0n, virtualHype: 61n * e, virtualToken: 1_000_000_000n * e }, 3)],
    ctx,
    1000,
  );
  assert.equal(trades.length, 1);
  assert.deepEqual([trades[0].venue, trades[0].side, trades[0].trader, trades[0].hype, trades[0].tokens, trades[0].ts], ["curve", "buy", "0xab", 1, 1000, 1000]);
  close(trades[0].priceHype, 61 / 1_000_000_000);
});

test("router buy: price from Sync, trader from Swapped, logs out of order", () => {
  const logs = [
    log(ROUTER, "Swapped", { token: TOKEN, trader: "0xCAFE", to: "0xCAFE", isBuy: true, hypeAmount: 2n * e, tokenAmount: 500n * e }, 9),
    log(PAIR, "Swap", { sender: ROUTER, amount0In: 0n, amount1In: 2n * e, amount0Out: 500n * e, amount1Out: 0n, to: "0xCAFE" }, 6),
    log(PAIR, "Sync", { reserve0: 200_000_000n * e, reserve1: 172n * e }, 5),
  ];
  const { trades } = liveTrades(logs, ctx, 0);
  assert.equal(trades.length, 1, "one trade (router Swapped isn't double counted)");
  const t = trades[0];
  assert.deepEqual([t.venue, t.side, t.trader, t.hype, t.tokens], ["pool", "buy", "0xcafe", 2, 500]);
  assert.equal(t.logIndex, 9, "id matches the indexer's row (the router's Swapped log)");
  close(t.priceHype, 172 / 200_000_000);
});

test("aggregator sell straight on the pair: trader unknown, token1 orientation", () => {
  const W_LOW = "0x1000000000000000000000000000000000000000"; // WHYPE sorts first -> token is token1
  const c = { ...ctx, whype: W_LOW };
  const logs = [
    log(PAIR, "Sync", { reserve0: 170n * e, reserve1: 210_000_000n * e }, 1),
    log(PAIR, "Swap", { sender: "0xAgg", amount0In: 0n, amount1In: 1000n * e, amount0Out: e / 2n, amount1Out: 0n, to: "0xAgg" }, 2),
  ];
  const [t] = liveTrades(logs, c, 0).trades;
  assert.deepEqual([t.side, t.trader, t.hype, t.tokens], ["sell", null, 0.5, 1000]);
  close(t.priceHype, 170 / 210_000_000);
});

test("graduation is reported (so the watcher adds the new pair)", () => {
  const { graduated } = liveTrades([log(PAD, "Graduated", { token: TOKEN, pair: PAIR, hype: e, tokens: e, liquidityBurned: e }, 1)], ctx, 0);
  assert.deepEqual(graduated.map(({ token, pair }) => ({ token, pair })), [{ token: TOKEN, pair: PAIR }]);
});

test("two swaps in one tx each use their own Sync", () => {
  const logs = [
    log(PAIR, "Sync", { reserve0: 100n * e, reserve1: 10n * e }, 1),
    log(PAIR, "Swap", { sender: "0xA", amount0In: 0n, amount1In: e, amount0Out: e, amount1Out: 0n, to: "0xA" }, 2),
    log(PAIR, "Sync", { reserve0: 90n * e, reserve1: 12n * e }, 3),
    log(PAIR, "Swap", { sender: "0xA", amount0In: 0n, amount1In: e, amount0Out: e, amount1Out: 0n, to: "0xA" }, 4),
  ];
  const [a, b] = liveTrades(logs, ctx, 0).trades;
  close(a.priceHype, 10 / 100);
  close(b.priceHype, 12 / 90);
});
