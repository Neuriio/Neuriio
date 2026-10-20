# Bonding curve

Every token starts on a bonding curve: a smart contract that sells the token and buys it back at a price set by a
formula. There's no order book and no seed liquidity, and everyone trades against the same curve.

## Supply

| Part | Tokens | Where it goes |
| --- | --- | --- |
| Sold on the curve | 793,100,000 (79.31%) | To buyers, one trade at a time |
| Pool reserve | 206,900,000 (20.69%) | Into the token's pool at [graduation](graduation.md) |
| **Total** | **1,000,000,000** | No creator, team or presale allocation |

## How the price moves

The curve is **constant product** over *virtual* reserves, the same model pump.fun uses. At launch it starts with a
virtual USDC reserve and 1.073B virtual tokens:

```
price = USDC reserve ÷ token reserve
USDC reserve × token reserve = constant
```

Each buy adds USDC and removes tokens, so the price rises; each sell does the opposite. Early buyers pay less because
fewer tokens have been sold, not because anyone got a special deal.

## Graduation threshold

The curve sells out when all 793.1M curve tokens are sold. How much USDC that takes depends on the starting virtual
USDC reserve:

| Network | Starting virtual USDC | USDC raised at graduation | Market cap at graduation |
| --- | --- | --- | --- |
| Elysium testnet | 6,000 | about 17,000 | about $82k |
| Mainnet (planned) | about 5,109 | about 14,500 | about $70k |

The closing price on the curve is exactly the pool's opening price, so there's no jump at graduation.

## Buying and selling

* **Buy and sell any time** until the token graduates. After that, trading moves to its pool.
* **Fee:** 1% of each curve trade, paid in USDC. See [Trading and fees](../trading/trading-and-fees.md).
* **Protection:** every trade has a minimum amount out (slippage limit) and a deadline. If the price moves past your
  limit, or the deadline passes, the trade cancels instead of filling at a worse price.
