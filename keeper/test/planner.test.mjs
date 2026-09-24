import { test } from "node:test";
import assert from "node:assert/strict";
import { fromUnits, planHedge, roundPx, roundSz, unhedgedNotional } from "../src/planner.mjs";

const base = { mid: 93.61, hedgeRatio: 1, szDecimals: 2, minNotional: 10, maxSlippageBps: 20 };

test("fromUnits handles 18 and 6 decimals exactly", () => {
  assert.equal(fromUnits(94_661950000000000000n, 18), 94.66195);
  assert.equal(fromUnits(5n, 6), 0.000005);
  assert.equal(fromUnits(0n, 18), 0);
});

test("roundPx follows HL perp tick rules and rounds in the safe direction", () => {
  // 2 int digits -> max 3 decimals (5 sig figs); szDecimals 2 -> max 4 decimals
  assert.equal(roundPx(93.62456, 2, "down"), "93.624");
  assert.equal(roundPx(93.62456, 2, "up"), "93.625");
  // 5 int digits -> integer only
  assert.equal(roundPx(97123.7, 5, "down"), "97123");
  assert.equal(roundPx(97123.2, 5, "up"), "97124");
  // szDecimals caps decimals: 6 - 4 = 2
  assert.equal(roundPx(3.14159, 4, "down"), "3.14");
  // exact values don't get bumped
  assert.equal(roundPx(93.5, 2, "up"), "93.500");
});

test("roundSz rounds down to lot size", () => {
  assert.equal(roundSz(5.33805, 2), "5.33");
  assert.equal(roundSz(0.009, 2), "0.00");
});

test("fresh pool: short the whole base inventory", () => {
  const p = planHedge({ ...base, poolBase: 100, perpPosition: 0 });
  assert.equal(p.isBuy, false);
  assert.equal(p.sz, "100.00");
  assert.equal(p.limitPx, "93.423"); // 93.61 * (1 - 20bps) = 93.4228 -> up
});

test("trader bought 10 HYPE from pool: buy back 10 perp", () => {
  const p = planHedge({ ...base, poolBase: 90, perpPosition: -100 });
  assert.equal(p.isBuy, true);
  assert.equal(p.sz, "10.00");
  assert.equal(p.limitPx, "93.797"); // 93.61 * 1.002 = 93.79722 -> down
});

test("trader sold 10 HYPE to pool: sell 10 more perp", () => {
  const p = planHedge({ ...base, poolBase: 110, perpPosition: -100 });
  assert.equal(p.isBuy, false);
  assert.equal(p.sz, "10.00");
});

test("already hedged or dust below $10: no order", () => {
  assert.equal(planHedge({ ...base, poolBase: 100, perpPosition: -100 }), null);
  assert.equal(planHedge({ ...base, poolBase: 100.1, perpPosition: -100 }), null); // $9.36
  assert.notEqual(planHedge({ ...base, poolBase: 100.11, perpPosition: -100 }), null); // $10.30
});

test("hedgeRatio scales the target", () => {
  const p = planHedge({ ...base, hedgeRatio: 0.5, poolBase: 100, perpPosition: 0 });
  assert.equal(p.sz, "50.00");
  assert.equal(planHedge({ ...base, hedgeRatio: 0, poolBase: 100, perpPosition: 0 }), null);
});

test("unhedgedNotional", () => {
  assert.equal(unhedgedNotional({ poolBase: 90, perpPosition: -100, mid: 100, hedgeRatio: 1 }), 1000);
  assert.equal(unhedgedNotional({ poolBase: 100, perpPosition: -100, mid: 100, hedgeRatio: 1 }), 0);
});
