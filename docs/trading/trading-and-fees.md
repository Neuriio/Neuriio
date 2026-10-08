# Trading and fees

Every token trades in HYPE: on its bonding curve until it graduates, then on its own pool.

## Where a token trades

| Stage | Market | Fee per trade |
| --- | --- | --- |
| Before graduation | [Bonding curve](../launching/bonding-curve.md) | 0.75% |
| After graduation | Its pool (Uniswap V2 fork) | 0.25% |

You don't have to choose: buying or selling from a token's page in Explore uses the right market automatically.

## Where fees go

All fees are collected in HYPE by the **NeuriioFees** contract and split between the token's creator and the protocol:

| Fee from | Creator | Protocol |
| --- | --- | --- |
| Curve trades (0.75%) | 20% | 80% |
| Pool trades (0.25%) | 80% | 20% |

The protocol share is split between **community rewards (60%)** and **buybacks (40%)**.

The creator percentages are fixed in the contract: nobody, including Neuriio, can lower a creator's share of fees
from that contract.

## Protection on every trade

* **Slippage limit.** You set the minimum you'll accept. If the price moves past it before your trade lands, the trade
  cancels.
* **Deadline.** A trade that isn't included in time cancels instead of filling later at a different price.
* **Sells stay open.** If launches and buys are ever paused in an emergency, selling keeps working so holders can always
  exit.

## Costs you pay

* The trading fee above.
* A small amount of HYPE for gas on Elysium.

There's no fee to launch, to send tokens, or to claim creator fees (beyond gas).
