# Graduation and locked liquidity

A token **graduates** when the last of its 793.1M curve tokens is sold. Graduation happens inside that same trade: no
one has to trigger it, and there's no gap between the curve closing and the pool opening.

## What happens at graduation

1. All the USDC the curve raised, plus the remaining **206.9M tokens**, move into the token's own pool (the token paired
   with USDC).
2. The pool mints its LP tokens, which represent ownership of that liquidity.
3. **All LP tokens are sent to the dead address `0x…dEaD`.** Nobody holds them, so nobody can ever withdraw the
   liquidity, including the creator and Neuriio.
4. The pool opens at the curve's closing price, and trading continues there.

## Why nobody can get in first

* **Only Neuriio's launchpad can create a token's pool.** Nobody can open the pool early at a bad price and wait for
  graduation.
* **Tokens or USDC sent to the pool's address before graduation are swept to `0x…dEaD`** before the liquidity is added,
  so they can't be used to skew the opening price.
* The curve is the only market until graduation, and everyone trades it on the same terms.

## After graduation

The token trades on its pool through the Neuriio router. Pools charge **1%** per swap: 40% to the people staking the
token, 40% to Neuriio stakers, 10% to the creator and 10% to the treasury. See
[Trading and fees](../trading/trading-and-fees.md).

Graduation also **opens staking** for the token: holders can stake it to share its pool fees and mint Neuriio. See
[Staking](../trading/staking.md).

{% hint style="info" %}
The pool is a fork of Uniswap V2, the most widely used and audited AMM design. Neuriio's changes are small and marked
in the [verified source](../trust/safety-and-contracts.md).
{% endhint %}
