// How a batch of matched fees gets split (user, 2026-11-01): 40% to each token's stakers, by what that token paid; the
// rest to the treasury wallet, where the KNTQ buyback is done by hand. A token with no stakers sends its 40% to treasury
// too, because the staking contract would hold it for whoever stakes first.
export const STAKERS_BPS = 4000n;

/** `receipts`: [{ token, amount (bigint) }]; `staked`: Map of token -> total staked (bigint). Always adds up to the total. */
export function planPayout(receipts, staked) {
  const byToken = new Map();
  let total = 0n;
  for (const r of receipts) {
    byToken.set(r.token, (byToken.get(r.token) ?? 0n) + r.amount);
    total += r.amount;
  }
  const rewards = [];
  let paid = 0n;
  for (const [token, amount] of [...byToken].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const reward = (amount * STAKERS_BPS) / 10_000n;
    if (reward === 0n || !((staked.get(token) ?? 0n) > 0n)) continue;
    rewards.push({ token, amount: reward });
    paid += reward;
  }
  return { total, rewards, treasury: total - paid };
}
