# Creator fees

Once your token graduates, every swap in its pool pays you, in USDC.

## How much

| Where your token trades | Fee per trade | Your share | You earn |
| --- | --- | --- | --- |
| Bonding curve | 1% | — | — |
| Pool (after graduation) | 1% | 10% | 0.1% of pool volume |

Example: if your graduated token trades $10,000 of volume in its pool, you earn $10.

Curve fees go to Neuriio stakers, the KNTQ buyback and the treasury. See [Trading and fees](trading-and-fees.md) for the
full split.

## Claiming

1. Open **Account**. The **Creator fees** box shows what you can claim.
2. Click **Claim**. The USDC goes to your Neuriio wallet.

You can claim any time, as often as you like; you only pay gas. Unclaimed fees wait for you in the NeuriioFees contract
and never expire.

## FTFs

An [FTF](../launching/launch-an-ftf.md)'s creator share is split equally between its four members: each claims 25% of it
from their own Account panel.

## Fixed shares

The 10% creator share is a constant in the NeuriioFees contract. Changing it would mean deploying a new contract
publicly, and fees already earned stay claimable from the old one.
