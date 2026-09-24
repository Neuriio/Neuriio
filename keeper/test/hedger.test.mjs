import { test } from "node:test";
import assert from "node:assert/strict";
import { Hedger } from "../src/hedger.mjs";
import { SimExchange } from "../src/exchange/sim.mjs";

const cfg = { hedgeRatio: 1, maxSlippageBps: 20, minNotional: 10, maxUnhedgedUsd: 500, graceMs: 3000 };

function setup({ poolBase = 100, exchangeOpts = {}, cfgOverrides = {} } = {}) {
  const pool = { base: poolBase, pauses: 0 };
  const exchange = new SimExchange({ mid: 93.61, ...exchangeOpts });
  let t = 0;
  const logs = [];
  const hedger = new Hedger({
    exchange,
    cfg: { ...cfg, ...cfgOverrides },
    getPoolBase: async () => pool.base,
    pausePool: async () => void pool.pauses++,
    log: (e) => logs.push(e),
    now: () => t,
  });
  return { pool, exchange, hedger, logs, advance: (ms) => (t += ms) };
}

test("tracks pool inventory through a series of trades", async () => {
  const { pool, exchange, hedger } = setup();
  await hedger.reconcile();
  assert.equal(exchange.position, -100);

  for (const b of [94.66, 97.66, 80, 80.05, 120]) {
    pool.base = b;
    await hedger.reconcile("swap");
    // within one lot or below $10 min notional
    assert.ok(Math.abs(exchange.position + b) * 93.61 < 10, `pool ${b} perp ${exchange.position}`);
  }
  assert.equal(exchange.position, -120);
});

test("partial fills converge over successive passes", async () => {
  const { exchange, hedger } = setup({ exchangeOpts: { fillRatio: 0.5 } });
  await hedger.reconcile();
  // 100 -> 50 -> 75 -> 87.5 with 3 orders per pass
  assert.equal(exchange.orders.length, 3);
  assert.equal(exchange.position, -87.5);
  // gap halves per order; a few more passes close it to below the $10 minimum order
  for (let i = 0; i < 3; i++) await hedger.reconcile();
  assert.ok(Math.abs(exchange.position + 100) * 93.61 < 10, `perp ${exchange.position}`);
});

test("overlapping triggers never place concurrent orders", async () => {
  const { exchange, hedger } = setup();
  let inFlight = 0;
  let maxInFlight = 0;
  const orig = exchange.placeIoc.bind(exchange);
  exchange.placeIoc = async (o) => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, 10));
    const res = await orig(o);
    inFlight--;
    return res;
  };
  await Promise.all([hedger.reconcile("swap"), hedger.reconcile("swap"), hedger.reconcile("timer")]);
  assert.equal(maxInFlight, 1);
  assert.equal(exchange.position, -100);
  assert.equal(exchange.orders.length, 1, "coalesced pass found nothing left to do");
});

test("pauses pool once when hedge can't fill for longer than grace period", async () => {
  const { pool, hedger, logs, advance } = setup({ exchangeOpts: { fillRatio: 0 } });
  await hedger.reconcile(); // unhedged $9,361 > $500: breach starts
  assert.equal(pool.pauses, 0);
  advance(2_999);
  await hedger.reconcile();
  assert.equal(pool.pauses, 0);
  advance(1);
  await hedger.reconcile();
  assert.equal(pool.pauses, 1);
  advance(10_000);
  await hedger.reconcile();
  assert.equal(pool.pauses, 1, "only pauses once");
  assert.ok(logs.some((l) => l.ev === "pool_paused"));
});

test("breach timer resets when hedge recovers", async () => {
  const { pool, exchange, hedger, advance } = setup({ exchangeOpts: { fillRatio: 0 } });
  await hedger.reconcile();
  advance(2_000);
  exchange.fillRatio = 1;
  await hedger.reconcile(); // hedged now -> timer reset
  exchange.fillRatio = 0;
  pool.base = 200;
  await hedger.reconcile(); // new breach starts
  advance(2_000);
  await hedger.reconcile();
  assert.equal(pool.pauses, 0);
});

test("exchange errors are logged, not thrown, and count toward the breach", async () => {
  const { pool, exchange, hedger, logs, advance } = setup();
  exchange.placeIoc = async () => {
    throw new Error("HL API 502");
  };
  await hedger.reconcile();
  advance(3_000);
  await hedger.reconcile();
  assert.equal(pool.pauses, 1);
  assert.ok(logs.some((l) => l.ev === "hedge_order" && l.error === "HL API 502"));
});

test("dry run plans but never trades or pauses", async () => {
  const { pool, exchange, hedger, logs, advance } = setup({ cfgOverrides: { dryRun: true } });
  await hedger.reconcile();
  advance(60_000);
  await hedger.reconcile();
  assert.equal(exchange.orders.length, 0);
  assert.equal(pool.pauses, 0);
  assert.equal(logs.filter((l) => l.ev === "hedge_planned").length, 2);
});
