// Turns a user's trade intent into the exact HyperCore actions to sign, with our builder code on
// every order. Pure: validation, sizing, tick/lot rounding, fee preview.

export const HL_FEES_BPS = {
  // HyperCore base tier (tier 0). Outcome markets: zero fees to open per HIP-4.
  perp: { taker: 4.5, maker: 1.5 },
  spot: { taker: 7, maker: 4 },
  outcome: { taker: 0, maker: 0 },
};
export const MAX_BUILDER_FEE = { perp: 100, spot: 1000, outcome: 1000 }; // tenths of a bp
export const MIN_NOTIONAL_USD = 10;

/**
 * HyperCore tick rules: <= 5 significant figures and <= (6 perp | 8 spot/outcome) - szDecimals
 * decimals; integers always allowed. Rounds in `direction` so limits never get more aggressive.
 */
export function formatPx(px, szDecimals, kind, direction) {
  if (!(px > 0)) throw new Error(`invalid price ${px}`);
  const maxDecimals = (kind === "perp" ? 6 : 8) - szDecimals;
  // digits before the decimal point; <= 0 for prices below 1 (leading zeros aren't significant)
  const intDigits = Math.floor(Math.log10(px)) + 1;
  const decimals = Math.max(0, Math.min(maxDecimals, 5 - intDigits));
  const f = 10 ** decimals;
  const r = direction === "up" ? Math.ceil(px * f - 1e-9) : Math.floor(px * f + 1e-9);
  if (r === 0) throw new Error(`price ${px} rounds to zero`);
  return trimZeros((r / f).toFixed(decimals));
}

export function formatSz(sz, szDecimals) {
  const f = 10 ** szDecimals;
  return trimZeros((Math.floor(sz * f + 1e-9) / f).toFixed(szDecimals));
}

const trimZeros = (s) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

/**
 * @param {object} market   from MarketCatalog
 * @param {object} intent
 * @param {"buy"|"sell"} intent.side             buy = long / buy YES / buy spot
 * @param {number} [intent.size]                  base units; or give intent.usd
 * @param {number} [intent.usd]                   margin in USDC (perps: notional = usd * leverage)
 * @param {number} [intent.leverage]              perps only, 1..maxLeverage
 * @param {boolean} [intent.cross]                perps margin mode (default cross unless onlyIsolated)
 * @param {"market"|"limit"} [intent.type]
 * @param {number} [intent.limitPx]
 * @param {number} [intent.slippageBps]           market orders: IOC limit this far from mid
 * @param {boolean} [intent.reduceOnly]
 * @param {number} [intent.takeProfit]            perps: trigger price
 * @param {number} [intent.stopLoss]              perps: trigger price
 * @param {object} ctx { builder?: { address, fees: {perp, spot, outcome} } }  omit for no builder fee
 * @returns {{ actions: object[], summary: object }}
 */
export function buildOrderPlan(market, intent, { builder } = {}) {
  const { kind, szDecimals } = market;
  const isBuy = intent.side === "buy";
  if (intent.side !== "buy" && intent.side !== "sell") throw new Error(`side must be buy or sell`);
  const type = intent.type ?? "market";
  const mid = market.mid;
  if (!(mid > 0)) throw new Error(`no price for ${market.symbol}`);

  // leverage
  let leverage = 1;
  if (kind === "perp") {
    leverage = intent.leverage ?? 1;
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > market.maxLeverage) {
      throw new Error(`leverage must be 1-${market.maxLeverage}x for ${market.symbol}`);
    }
  } else if (intent.leverage && intent.leverage !== 1) {
    throw new Error(`${kind} markets have no leverage`);
  }

  // price
  const slip = (intent.slippageBps ?? 50) / 10_000;
  let px;
  if (type === "limit") {
    if (!(intent.limitPx > 0)) throw new Error("limit order needs limitPx");
    px = formatPx(intent.limitPx, szDecimals, kind, isBuy ? "down" : "up");
  } else {
    px = formatPx(mid * (isBuy ? 1 + slip : 1 - slip), szDecimals, kind, isBuy ? "down" : "up");
  }
  if (kind === "outcome" && !(Number(px) > 0 && Number(px) < 1)) {
    throw new Error(`outcome prices are probabilities between 0 and 1 (got ${px})`);
  }

  // size
  const refPx = type === "limit" ? Number(px) : mid;
  let sizeRaw;
  if (intent.size !== undefined) sizeRaw = intent.size;
  else if (intent.usd !== undefined) sizeRaw = (intent.usd * leverage) / refPx;
  else throw new Error("give size or usd");
  const sz = formatSz(sizeRaw, szDecimals);
  const notional = Number(sz) * refPx;
  if (Number(sz) <= 0) throw new Error("size rounds to zero");
  if (!intent.reduceOnly && notional < MIN_NOTIONAL_USD) {
    throw new Error(`minimum order is $${MIN_NOTIONAL_USD} (this is $${notional.toFixed(2)})`);
  }

  // builder code (optional: under the subscription model users pay only HyperCore's own fees)
  const f = builder?.fees?.[kind] ?? 0;
  if (!Number.isInteger(f) || f < 0 || f > MAX_BUILDER_FEE[kind]) throw new Error(`builder fee ${f} out of range for ${kind}`);
  const builderField = f > 0 ? { b: builder.address, f } : undefined;

  const tif = type === "market" ? "Ioc" : (intent.tif ?? "Gtc");
  const orders = [{ a: market.id, b: isBuy, p: px, s: sz, r: Boolean(intent.reduceOnly), t: { limit: { tif } } }];

  // TP/SL (perps): reduce-only trigger orders on the opposite side, executed as market
  const hasTpsl = intent.takeProfit !== undefined || intent.stopLoss !== undefined;
  if (hasTpsl) {
    if (kind !== "perp") throw new Error("take-profit / stop-loss are for perps");
    for (const [tpsl, trig] of [["tp", intent.takeProfit], ["sl", intent.stopLoss]]) {
      if (trig === undefined) continue;
      const wrongSide = tpsl === "tp" ? (isBuy ? trig <= mid : trig >= mid) : isBuy ? trig >= mid : trig <= mid;
      if (wrongSide) throw new Error(`${tpsl === "tp" ? "take-profit" : "stop-loss"} ${trig} is on the wrong side of ${mid}`);
      const triggerPx = formatPx(trig, szDecimals, kind, "down");
      // execution cap for the triggered market order, generous so the stop actually fills
      const execPx = formatPx(trig * (isBuy ? 1 - 10 * slip : 1 + 10 * slip), szDecimals, kind, isBuy ? "up" : "down");
      orders.push({ a: market.id, b: !isBuy, p: execPx, s: sz, r: true, t: { trigger: { isMarket: true, triggerPx, tpsl } } });
    }
  }

  const actions = [];
  if (kind === "perp" && !intent.reduceOnly) {
    const isCross = market.onlyIsolated ? false : (intent.cross ?? true);
    actions.push({ type: "updateLeverage", params: { asset: market.id, isCross, leverage } });
  }
  actions.push({
    type: "order",
    params: { orders, grouping: hasTpsl ? "normalTpsl" : "na", ...(builderField ? { builder: builderField } : {}) },
  });

  const hlFeeBps = HL_FEES_BPS[kind][type === "market" ? "taker" : "maker"];
  const builderFeeBps = f / 10;
  return {
    actions,
    summary: {
      market: market.symbol,
      kind,
      side: intent.side,
      type,
      size: sz,
      price: px,
      notionalUsd: round2(notional),
      marginUsd: round2(notional / leverage),
      leverage,
      fees: {
        hyperliquidUsd: round2((notional * hlFeeBps) / 10_000),
        builderUsd: round2((notional * builderFeeBps) / 10_000),
        builderBps: builderFeeBps,
      },
    },
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Which USDC balance an order spends from, and the transfer (if any) to top it up from the other.
 * HyperCore keeps two USDC balances: perps ("" dex) back perps; spot ("spot") backs spot AND HIP-4
 * outcomes. The bridge credits perps, so a spot/outcome buy usually needs a perps -> spot move first.
 * The app's agent can do that move itself (agentSendAsset, own account only), so no wallet prompt.
 *
 * @param {object} summary        buildOrderPlan(...).summary
 * @param {object} bal            { perp: withdrawable USDC, spot: free spot USDC } (numbers)
 * @returns {null | { sourceDex, destinationDex, amount: string }}  null = nothing to move
 */
export function planCollateralMove(summary, bal, { reduceOnly = false } = {}) {
  const { kind, side } = summary;
  if (reduceOnly || (kind !== "perp" && side === "sell")) return null; // sells don't spend USDC
  const toPerp = kind === "perp";
  const px = Number(summary.price);
  const size = Number(summary.size);
  const feeBps = HL_FEES_BPS[kind].taker; // worst case
  // what the order can lock at its limit price (market orders are IOC limits above mid)
  const need = toPerp
    ? (size * px) / summary.leverage + (size * px * feeBps) / 10_000
    : size * px * (1 + feeBps / 10_000);
  const have = toPerp ? bal.perp : bal.spot;
  if (have >= need) return null;
  const other = toPerp ? bal.spot : bal.perp;
  const shortfall = Math.ceil((need - have) * 100 - 1e-9) / 100; // whole cents, rounded up
  if (shortfall > other + 1e-9) {
    throw new Error(`not enough USDC: order needs $${need.toFixed(2)}, you have $${(have + other).toFixed(2)}`);
  }
  return { sourceDex: toPerp ? "spot" : "", destinationDex: toPerp ? "" : "spot", amount: shortfall.toFixed(2) };
}
