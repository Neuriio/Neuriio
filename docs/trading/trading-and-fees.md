# Trading and Fees

Tokens launched through Neuriio live on **Ascend**, the launchpad on Elysium. Each token trades in its Ascend pool, in **USDC**, from the moment it launches. You can trade it from its page in Explore, on Ascend, or through any app or aggregator that routes to Ascend's pools.

## The Fee

Every token traded pays the normal Ascend 1% plus our Builder Fee .5%:

| Part      | Fee      | Goes to                                                                                                |
| --------- | -------- | ------------------------------------------------------------------------------------------------------ |
| Ascend    | 1%       | Part to the token's creator (see [Creator fees](trading-and-fees.md#creator-fees)), the rest to Ascend |
| Neuriio   | 0.5%     | Shared out as below                                                                                    |
| **Total** | **1.5%** |                                                                                                        |

The fee is charged by the pool, so it applies to every trade on any site, including bots and aggregators. Trading through Neuriio costs nothing extra.

## Where Neuriio's 0.5% goes

| Share    | Of the 0.5% | Of each trade |
| -------- | ----------- | ------------- |
| Stakers  | 40%         | 0.2%          |
| $KNTQ    | 40%         | 0.2%          |
| Treasury | 20%         | 0.1%          |

* **Token stakers** are people who stake the token that was traded, shared by how much each has staked. See [Staking](staking.md).
* **KNTQ buyback:** USDC used to buy back KNTQ, the Kinetiq token.
* **Treasury:** Neuriio's own funds for future community rewards.

If nobody is staking a token, its stakers' share goes back to the holders.

Neuriio's share is collected in USDC and paid out to each token's stakers regularly.

## Creator Fees

The creator of every token launched through Neuriio earns part of Ascend's 1%, paid by Ascend in USDC. An FTF's share is split equally between its four members.

| Token's market cap | Creator's share of each trade                      |
| ------------------ | -------------------------------------------------- |
| Under $40k         | 0.35% (0.10% paid as trades happen, the rest held) |
| $40k to $1M        | 0.50%                                              |
| $1M to $10M        | 0.55%                                              |
| $10M to $50M       | 0.60%                                              |
| $50M+              | 0.75%                                              |

Below a $40k market cap, most of the creator's share is held. It's released once the token's average price stays above a $40k market cap for one hour within 14 days of launch. If that doesn't happen, or the token goes quiet (under a $5k market cap and under $1k of daily volume for 7 days), the held fees are lost to buybacks and support for the token. These are Ascend's rules; see [Ascend's docs](https://ascendlaunch.gitbook.io/docs/fees-and-revenue/creator-fee-release-and-takeovers).

## Protection on every trade

* **Slippage limit.** You set the minimum you'll accept. If the price moves past it before your trade lands, the trade cancels.
* **Deadline.** A trade that isn't included in time cancels instead of filling later at a different price.

## Costs you pay

* The 1.5% trading fee.
* < $.001 HYPE for gas on Elysium.

The first time you buy, and the first time you sell a token, your wallet also approves that token for trading. It happens automatically and costs gas once.

There's no fee to launch, stake, send tokens or claim, beyond gas.
