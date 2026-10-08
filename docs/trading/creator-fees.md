# Creator fees

Every trade of your token pays you, in HYPE, from the first trade on its curve to every swap in its pool.

## How much

| Where your token trades | Fee per trade | Your share | You earn |
| --- | --- | --- | --- |
| Bonding curve | 0.75% | 20% | 0.15% of curve volume |
| Pool (after graduation) | 0.25% | 80% | 0.20% of pool volume |

Example: if your graduated token trades 100 HYPE of volume in its pool, you earn 0.2 HYPE.

The share is larger after graduation on purpose: it rewards creators whose tokens keep trading.

## Claiming

1. Open **Account**. The **Creator fees** box shows what you can claim.
2. Click **Claim**. The HYPE goes to your Neuriio wallet.

You can claim any time, as often as you like; you only pay gas. Unclaimed fees wait for you in the NeuriioFees contract
and never expire.

## FTFs

An [FTF](../launching/launch-an-ftf.md)'s creator share is split equally between its four members: each claims 25% of it
from their own Account panel.

## Fixed shares

The 20% and 80% creator shares are constants in the NeuriioFees contract. Changing them would mean deploying a new
contract publicly, and fees already earned stay claimable from the old one.
