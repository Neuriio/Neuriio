import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketCatalog, normalizeMarkets, OUTCOME_BASE, SPOT_BASE } from "../src/trade/markets.mjs";
import { buildOrderPlan, formatPx, formatSz } from "../src/trade/orders.mjs";
import { summarizePortfolio } from "../src/trade/portfolio.mjs";

const BUILDER = { address: "0x000000000000000000000000000000000000b111", fees: { perp: 50, spot: 50, outcome: 0 } };

// Fixture shaped like live mainnet responses (trimmed)
const fixture = {
  meta: {
    universe: [
      { name: "BTC", szDecimals: 5, maxLeverage: 40 },
      { name: "OLD", szDecimals: 0, maxLeverage: 3, isDelisted: true },
      { name: "HYPE", szDecimals: 2, maxLeverage: 10 },
    ],
  },
  spotMeta: {
    tokens: [
      { name: "USDC", index: 0, szDecimals: 8 },
      { name: "HYPE", index: 150, szDecimals: 2 },
      { name: "KNTQ", index: 124, szDecimals: 0 },
    ],
    universe: [
      { name: "@107", index: 107, tokens: [150, 0] },
      { name: "@334", index: 334, tokens: [124, 0] },
    ],
  },
  outcomeMeta: {
    outcomes: [
      { outcome: 1209, name: "BTC above 100k", description: "d", quoteToken: "USDC", sideSpecs: [{ name: "Yes" }, { name: "No" }] },
      { outcome: 1300, name: "Fallback", description: "", quoteToken: "USDC", sideSpecs: [{ name: "Yes" }, { name: "No" }] },
    ],
    questions: [{ question: 1, name: "BTC price", description: "", fallbackOutcome: 1300, namedOutcomes: [1209], settledNamedOutcomes: [] }],
  },
  mids: { BTC: "97000", HYPE: "92.69", "@107": "92.7", "@334": "0.3302", "#12090": "0.54", "#12091": "0.46" },
};
const catalog = () => new MarketCatalog(normalizeMarkets(fixture));

// ------------------------------------------------------------------ markets

test("catalog: asset ids, delisted and fallback markets excluded", () => {
  const c = catalog();
  assert.equal(c.get("HYPE").id, 2);
  assert.equal(c.get("HYPE").kind, "perp");
  assert.equal(c.get("HYPE/USDC").id, SPOT_BASE + 107);
  assert.equal(c.get("@334").symbol, "KNTQ/USDC");
  assert.equal(c.get("BTC above 100k · Yes").id, OUTCOME_BASE + 12090);
  assert.equal(c.get("#12091").side, "No");
  assert.equal(c.get("+12090").question, "BTC price");
  assert.throws(() => c.get("OLD"), /unknown market/);
  assert.equal(c.list("outcome").length, 2, "fallback outcome not listed");
});

test("catalog: live price refresh", () => {
  const c = catalog();
  c.updateMids({ HYPE: "95" });
  assert.equal(c.get("HYPE").mid, 95);
});

// ------------------------------------------------------------------ formatting

test("price formatting per market kind", () => {
  assert.equal(formatPx(92.6912, 2, "perp", "down"), "92.691"); // 5 sig figs
  assert.equal(formatPx(0.330212, 0, "spot", "up"), "0.33022"); // spot: 8 - 0 decimals, 5 sig
  assert.equal(formatPx(0.5423, 5, "outcome", "down"), "0.542"); // outcome: 8 - 5 = 3 decimals
  assert.equal(formatPx(97123.9, 5, "perp", "down"), "97123");
  assert.equal(formatSz(10.789, 2), "10.78");
  assert.equal(formatPx(0.0123456, 0, "spot", "down"), "0.012345"); // 5 sig figs below 0.1
  assert.equal(formatPx(85, 2, "perp", "down"), "85", "no trailing zeros");
  assert.equal(formatSz(1000, 0), "1000");
});

// ------------------------------------------------------------------ order plans

test("10x HYPE long with $100 margin: leverage set, sized, builder attached", () => {
  const { actions, summary } = buildOrderPlan(catalog().get("HYPE"), { side: "buy", usd: 100, leverage: 10 }, { builder: BUILDER });
  assert.deepEqual(actions[0], { type: "updateLeverage", params: { asset: 2, isCross: true, leverage: 10 } });
  const { orders, grouping, builder } = actions[1].params;
  assert.equal(grouping, "na");
  assert.deepEqual(builder, { b: BUILDER.address, f: 50 });
  assert.deepEqual(orders[0], { a: 2, b: true, p: "93.153", s: "10.78", r: false, t: { limit: { tif: "Ioc" } } });
  assert.equal(summary.notionalUsd, 999.2);
  assert.equal(summary.marginUsd, 99.92);
  assert.equal(summary.fees.hyperliquidUsd, 0.45); // 4.5 bps taker
  assert.equal(summary.fees.builderUsd, 0.5); // 5 bps
});

test("short with take-profit and stop-loss", () => {
  const { actions } = buildOrderPlan(
    catalog().get("HYPE"),
    { side: "sell", usd: 50, leverage: 5, takeProfit: 85, stopLoss: 97 },
    { builder: BUILDER },
  );
  const { orders, grouping } = actions[1].params;
  assert.equal(grouping, "normalTpsl");
  assert.equal(orders.length, 3);
  const [entry, tp, sl] = orders;
  assert.equal(entry.b, false);
  assert.deepEqual(tp.t, { trigger: { isMarket: true, triggerPx: "85", tpsl: "tp" } });
  assert.equal(tp.b, true);
  assert.equal(tp.r, true);
  assert.equal(tp.s, entry.s);
  assert.deepEqual(sl.t, { trigger: { isMarket: true, triggerPx: "97", tpsl: "sl" } });
});

test("TP/SL on the wrong side of the price is rejected", () => {
  const hype = catalog().get("HYPE");
  assert.throws(() => buildOrderPlan(hype, { side: "buy", usd: 50, leverage: 2, takeProfit: 80 }, { builder: BUILDER }), /wrong side/);
  assert.throws(() => buildOrderPlan(hype, { side: "buy", usd: 50, leverage: 2, stopLoss: 99 }, { builder: BUILDER }), /wrong side/);
});

test("leverage limits and $10 minimum", () => {
  const hype = catalog().get("HYPE");
  assert.throws(() => buildOrderPlan(hype, { side: "buy", usd: 100, leverage: 11 }, { builder: BUILDER }), /1-10x/);
  assert.throws(() => buildOrderPlan(hype, { side: "buy", usd: 5, leverage: 1 }, { builder: BUILDER }), /minimum order is \$10/);
  assert.throws(() => buildOrderPlan(catalog().get("KNTQ/USDC"), { side: "buy", usd: 50, leverage: 3 }, { builder: BUILDER }), /no leverage/);
});

test("spot limit sell of KNTQ: no leverage action, builder fee on spot", () => {
  const { actions, summary } = buildOrderPlan(
    catalog().get("KNTQ/USDC"),
    { side: "sell", size: 1000, type: "limit", limitPx: 0.35 },
    { builder: BUILDER },
  );
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].params.orders[0], { a: 10334, b: false, p: "0.35", s: "1000", r: false, t: { limit: { tif: "Gtc" } } });
  assert.equal(summary.fees.builderUsd, 0.18);
});

test("outcome: buy YES with $20, priced as a probability, no builder fee by default", () => {
  const { actions, summary } = buildOrderPlan(catalog().get("#12090"), { side: "buy", usd: 20 }, { builder: BUILDER });
  const o = actions[0].params.orders[0];
  assert.equal(o.a, OUTCOME_BASE + 12090);
  assert.equal(o.p, "0.542"); // 0.54 + 50bps slippage, 3 decimals
  assert.equal(o.s, "37.03703");
  assert.equal(actions[0].params.builder, undefined);
  assert.equal(summary.fees.hyperliquidUsd, 0);
  assert.throws(
    () => buildOrderPlan(catalog().get("#12090"), { side: "buy", size: 30, type: "limit", limitPx: 1.2 }, { builder: BUILDER }),
    /between 0 and 1/,
  );
});

test("reduce-only close skips the minimum and the leverage update", () => {
  const { actions } = buildOrderPlan(catalog().get("HYPE"), { side: "sell", size: 0.05, reduceOnly: true }, { builder: BUILDER });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].params.orders[0].r, true);
});

test("default (subscription model): no builder code, user pays only HyperCore fees", () => {
  const { actions, summary } = buildOrderPlan(catalog().get("HYPE"), { side: "buy", usd: 100, leverage: 10 });
  assert.equal(actions[1].params.builder, undefined);
  assert.equal(summary.fees.builderUsd, 0);
  assert.equal(summary.fees.hyperliquidUsd, 0.45);
});

test("builder fee above HyperCore's cap is refused", () => {
  const bad = { ...BUILDER, fees: { ...BUILDER.fees, perp: 101 } };
  assert.throws(() => buildOrderPlan(catalog().get("HYPE"), { side: "buy", usd: 50, leverage: 1 }, { builder: bad }), /out of range/);
});

// ------------------------------------------------------------------ portfolio

test("portfolio: perps, spot and outcome positions with PnL", () => {
  const p = summarizePortfolio({
    catalog: catalog(),
    perpState: {
      marginSummary: { accountValue: "1100" },
      withdrawable: "900",
      assetPositions: [
        {
          position: {
            coin: "HYPE",
            szi: "10.78",
            entryPx: "90",
            positionValue: "999.2",
            unrealizedPnl: "29",
            returnOnEquity: "0.29",
            liquidationPx: "81.5",
            leverage: { type: "cross", value: 10 },
            marginUsed: "99.9",
            cumFunding: { allTime: "0", sinceOpen: "0.12", sinceChange: "0" },
          },
        },
      ],
    },
    spotState: {
      balances: [
        { coin: "USDC", token: 0, total: "50", hold: "0", entryNtl: "0" },
        { coin: "KNTQ", token: 124, total: "1000", hold: "0", entryNtl: "300" },
        { coin: "+12090", total: "37", hold: "0", entryNtl: "18" },
        { coin: "HYPE", token: 150, total: "0", hold: "0", entryNtl: "0" },
      ],
    },
  });
  assert.equal(p.perps[0].side, "long");
  assert.ok(Math.abs(p.perps[0].roePct - 29) < 1e-9);
  assert.equal(p.perps[0].fundingSinceOpen, -0.12);
  assert.equal(p.spot.length, 2, "zero balances hidden");
  const kntq = p.spot.find((s) => s.coin === "KNTQ");
  assert.equal(kntq.value, 330.2);
  assert.ok(Math.abs(kntq.pnl - 30.2) < 1e-9);
  const yes = p.outcomes[0];
  assert.equal(yes.symbol, "BTC above 100k · Yes");
  assert.equal(yes.value, 37 * 0.54);
  assert.equal(yes.payoutIfWins, 37);
  assert.ok(Math.abs(p.totals.netValue - (1100 + 50 + 330.2 + 19.98)) < 1e-9);
});
