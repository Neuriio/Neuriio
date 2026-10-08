# Safety and contracts

Every Neuriio contract is verified on the Elysium explorer, so anyone can read the exact code that runs.

## Contracts (Elysium testnet)

| Contract | What it does | Address |
| --- | --- | --- |
| NeuriioPad | Launches tokens, runs bonding curves, graduates tokens | [`0xd994…5e59`](https://elysium.kinetiq.xyz/address/0xd9943d81b72aa55e52580bbb595af797b04d5e59) |
| NeuriioRegistry | Permanent record of every token and its creators; one token per X account | [`0xd787…84fc`](https://elysium.kinetiq.xyz/address/0xd7879e97c6558486ca0a92283d70a46e89ea84fc) |
| NeuriioFees | Collects all fees in HYPE; creators claim here | [`0x7e9e…9b2b`](https://elysium.kinetiq.xyz/address/0x7e9e5e96c3e99fd201a15e6a33c59aec51a39b2b) |
| NeuriioSwap | Router for trading graduated tokens | [`0x4a85…acac`](https://elysium.kinetiq.xyz/address/0x4a85eca6f3ef4a07d049bd1907debb3e8961acac) |
| Pool factory | Uniswap V2 fork; creates each token's pool | [`0xd30f…339c`](https://elysium.kinetiq.xyz/address/0xd30f539cf731d843534a9e3fe9fec51bb456339c) |
| WHYPE | Wrapped HYPE used in pools | [`0x517f…14c7`](https://elysium.kinetiq.xyz/address/0x517f12d5d17c4755fbdf988fe9cc24334c3314c7) |

Each launched token is a standard ERC-20 (NeuriioToken) with a fixed supply of 1B: no minting, no transfer fees, no
blacklist.

## What's guaranteed by code

* **Locked liquidity.** At graduation all LP tokens go to `0x…dEaD`. No function can withdraw them.
* **No creator or team allocation.** The full supply is created inside NeuriioPad and only leaves through the curve or
  the pool.
* **Only the launchpad opens pools.** The pool factory accepts a new pool only from the token's own NeuriioPad.
* **Fixed creator shares.** The 20% / 80% creator shares are constants in NeuriioFees.
* **Sells can't be paused.** The emergency pause stops launches and buys only.

## What the owner can do

The contracts have an owner, which can:

* Pause and unpause **launches and buys** in an emergency (never sells).
* Change the curve fee for future trades, up to a hard cap of **2%** (it's 0.75%).
* Change the starting virtual HYPE for **new** launches only.
* Approve a new NeuriioPad version for new launches. Existing tokens keep trading on their own version.
* Point **future** fees at a new NeuriioFees contract. Balances already earned stay claimable in the old one.
* Reserve tickers and rotate the key that approves launches.

None of these can move users' tokens, HYPE, pool liquidity or creator balances.

{% hint style="info" %}
Before mainnet, ownership moves from a single key to a multisig, and the contracts get a formal security audit.
{% endhint %}
