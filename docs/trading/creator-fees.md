# Creator fees

Every trade of your token pays you, in USDC: from the first buy on its bonding curve to every swap in its pool.

## How much

| Where your token trades | Fee per trade | Your share | You earn |
| --- | --- | --- | --- |
| Bonding curve | 1% | 10% | 0.1% of curve volume |
| Pool (after graduation) | 1% | 10% | 0.1% of pool volume |

Example: if your token trades $10,000 of volume, on its curve or in its pool, you earn $10.

See [Trading and fees](trading-and-fees.md) for where the rest of each fee goes.

## Claiming

1. Open **Account**. The **Creator fees** box shows what you can claim.
2. Click **Claim**. The USDC goes to your Neuriio wallet.

You can claim any time, as often as you like; you only pay gas. Unclaimed fees wait for you in the NeuriioFees contract
and never expire.

## FTFs

An [FTF](../launching/launch-an-ftf.md)'s creator share is split equally between its four members: each claims 25% of it
from their own Account panel.

## Fixed shares

The 10% creator shares are constants in the NeuriioFees contract. Changing them would mean deploying a new contract
publicly, and fees already earned stay claimable from the old one.
