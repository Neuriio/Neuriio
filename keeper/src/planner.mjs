// Pure hedge math: no I/O, so it is fully unit-testable.
//
// Target: perp position = -(pool base inventory × hedgeRatio). At hedgeRatio 1 the pool's
// HYPE exposure is exactly offset, so the system earns spread and is price-neutral.

/** Convert a raw on-chain amount (bigint, `decimals`) to a JS number of whole tokens. */
export function fromUnits(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, "0");
  return Number(`${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`);
}

/**
 * Hyperliquid tick rules (perps): <= 5 significant figures and <= (6 - szDecimals) decimals;
 * integers always allowed. Rounds in the given direction so limits never get more aggressive.
 */
export function roundPx(px, szDecimals, direction) {
  if (!(px > 0)) throw new Error(`bad price ${px}`);
  const intDigits = Math.max(1, Math.floor(Math.log10(px)) + 1);
  const decimals = Math.max(0, Math.min(6 - szDecimals, 5 - intDigits));
  const f = 10 ** decimals;
  const scaled = px * f;
  const r = direction === "up" ? Math.ceil(scaled - 1e-9) : Math.floor(scaled + 1e-9);
  return (r / f).toFixed(decimals);
}

/** Round size down to the asset's lot size. */
export function roundSz(sz, szDecimals) {
  const f = 10 ** szDecimals;
  return (Math.floor(sz * f + 1e-9) / f).toFixed(szDecimals);
}

/**
 * @param {object} p
 * @param {number} p.poolBase        pool base inventory, whole tokens
 * @param {number} p.perpPosition    current signed perp size (negative = short), whole tokens
 * @param {number} p.mid             current perp mid price
 * @param {number} p.hedgeRatio      1 = fully neutral
 * @param {number} p.szDecimals      perp lot precision
 * @param {number} p.minNotional     skip orders smaller than this (HL minimum is $10)
 * @param {number} p.maxSlippageBps  IOC limit distance from mid
 * @returns {null | {isBuy: boolean, sz: string, limitPx: string, target: number, diff: number}}
 */
export function planHedge({ poolBase, perpPosition, mid, hedgeRatio, szDecimals, minNotional, maxSlippageBps }) {
  const target = -poolBase * hedgeRatio;
  const diff = target - perpPosition; // >0: need to buy, <0: need to sell
  const isBuy = diff > 0;
  const sz = roundSz(Math.abs(diff), szDecimals);
  if (Number(sz) === 0 || Number(sz) * mid < minNotional) return null;

  const slip = maxSlippageBps / 10_000;
  const limitPx = isBuy ? roundPx(mid * (1 + slip), szDecimals, "down") : roundPx(mid * (1 - slip), szDecimals, "up");
  return { isBuy, sz, limitPx, target, diff };
}

/** Dollar value of exposure the hedge is not covering. */
export function unhedgedNotional({ poolBase, perpPosition, mid, hedgeRatio }) {
  return Math.abs(-poolBase * hedgeRatio - perpPosition) * mid;
}
