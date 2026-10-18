# Trading and fees

Every token trades in **USDC**: on its bonding curve until it graduates, then on its own pool.

## Where a token trades

| Stage | Market | Fee per trade |
| --- | --- | --- |
| Before graduation | [Bonding curve](../launching/bonding-curve.md) | 1% |
| After graduation | Its pool (Uniswap V2 fork) | 1% |

You don't have to choose: buying or selling from a token's page in Explore uses the right market automatically. The
1% is built into the pool itself, so it applies to every swap, including bots and aggregators.

## Where fees go

All fees are collected in USDC by the **NeuriioFees** contract and shared out on every trade:

| Fee from | Neuriio stakers | Token stakers | Creator | KNTQ buyback | Treasury |
| --- | --- | --- | --- | --- | --- |
| Curve trades (1%) | 80% | — | — | 10% | 10% |
| Pool trades (1%) | 40% | 40% | 10% | — | 10% |

* **Neuriio stakers** are people who stake Neuriio, the platform token. See [Staking](staking.md).
* **Token stakers** are people who stake that graduated token. Staking opens at graduation. See [Staking](staking.md).
* **Creator** is the token's creator, or an FTF's four members. See [Creator fees](creator-fees.md).
* **KNTQ buyback:** USDC used to buy back KNTQ, the Kinetiq token.

If nobody is staking a token, its stakers' share goes to Neuriio stakers. If nobody is staking Neuriio, that share goes
to the treasury.

These percentages are constants in the NeuriioFees contract: nobody, including Neuriio, can change them in that
contract. A new split would mean deploying a new contract publicly.

## Protection on every trade

* **Slippage limit.** You set the minimum you'll accept. If the price moves past it before your trade lands, the trade
  cancels.
* **Deadline.** A trade that isn't included in time cancels instead of filling later at a different price.
* **Sells stay open.** If launches and buys are ever paused in an emergency, selling keeps working so holders can always
  exit.

## Costs you pay

* The 1% trading fee.
* A small amount of HYPE for gas on Elysium.

The first time you buy, and the first time you sell a token, your wallet also approves the Neuriio router to use that
token. It happens automatically and costs gas once.

There's no fee to launch, stake, send tokens, or claim (beyond gas).
