// Which token paid each fee. Ascend pays per trade, so a fee's USDC transfer sits in the same transaction as its swap.
// Anything uncertain stays unmatched: it's held in the wallet, never guessed at, until someone sets its token by hand.

/** One transaction's fee transfers and swaps -> each fee with its `token` and `pool`, or null and a `reason`.
 *  `fees`: [{ logIndex, from, ... }]; `swaps`: [{ pool, logIndex }]; `poolToToken`: Map of our pools; `feeSource`: when set,
 *  the only address fees may come from. */
export function matchFees(fees, swaps, poolToToken, feeSource) {
  const ours = swaps.filter((s) => poolToToken.has(s.pool));
  const pools = new Set(ours.map((s) => s.pool));
  const sorted = [...fees].sort((a, b) => a.logIndex - b.logIndex);
  return sorted.map((fee, i) => {
    if (feeSource && fee.from.toLowerCase() !== feeSource.toLowerCase()) return { ...fee, token: null, pool: null, reason: "unknown_sender" };
    if (ours.length === 0) return { ...fee, token: null, pool: null, reason: "no_swap" };
    // one of our pools in the transaction, or one fee per swap in the same order; anything else can't be told apart
    if (pools.size > 1 && sorted.length !== ours.length) return { ...fee, token: null, pool: null, reason: "ambiguous" };
    const pool = pools.size === 1 ? ours[0].pool : ours[i].pool;
    return { ...fee, token: poolToToken.get(pool), pool, reason: null };
  });
}
