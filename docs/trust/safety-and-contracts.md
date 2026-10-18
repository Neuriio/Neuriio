# Safety and contracts

Every Neuriio contract is verified on the Elysium explorer, so anyone can read the exact code that runs.

## Contracts (Elysium testnet)

| Contract | What it does | Address |
| --- | --- | --- |
| NeuriioPad | Launches tokens, runs bonding curves, graduates tokens | [`0x892b…8d76`](https://elysium.kinetiq.xyz/address/0x892b08a9b3987516a4ae5ab7d7e4d56642268d76) |
| NeuriioRegistry | Permanent record of every token and its creators; one token per X account | [`0x24dc…2219`](https://elysium.kinetiq.xyz/address/0x24dc6e578a7e2ea468ab300a50e23cc504d32219) |
| NeuriioFees | Collects every fee in USDC and shares it out; creators claim here | [`0x35cc…d6b9`](https://elysium.kinetiq.xyz/address/0x35cc3eb03c575083c01cf3f84f9136b77f5dd6b9) |
| NeuriioRouter | Every trade from the app, on the curve or in a pool | [`0x86cc…4776`](https://elysium.kinetiq.xyz/address/0x86cc9908c3f3953da13f2a8760afc25b3b6a4776) |
| NeuriioStaking | Holds staked tokens and pays stakers their share of fees | [`0x63e2…709a`](https://elysium.kinetiq.xyz/address/0x63e29d4f1929a9fc59e84c7ee75a50ca6b83709a) |
| Neuriio (platform token) | Minted only to people staking graduated tokens | [`0x5964…1089`](https://elysium.kinetiq.xyz/address/0x5964e0e586208992cbd0d419c56052b97a4b1089) |
| NeuriioMinter | Sets how much Neuriio each $1 of fees mints | [`0x2406…f031`](https://elysium.kinetiq.xyz/address/0x24067f1d414d1bb5fa0fb759d9129d6fed55f031) |
| Pool factory | Uniswap V2 fork; creates each token's USDC pool (1% fee) | [`0xf698…3b69`](https://elysium.kinetiq.xyz/address/0xf6988f1219341262450ae279790e2105c9173b69) |
| Test USDC | USDC for testnet only | [`0xe83c…0c7b`](https://elysium.kinetiq.xyz/address/0xe83c3630cab1c3d1d3b19a1f6ee393618c690c7b) |

Each launched token is a standard ERC-20 (NeuriioToken) with a fixed supply of 1B: no minting, no transfer fees, no
blacklist.

## What's guaranteed by code

* **Locked liquidity.** At graduation all LP tokens go to `0x…dEaD`. No function can withdraw them.
* **No creator or team allocation.** The full supply is created inside NeuriioPad and only leaves through the curve or
  the pool.
* **Only the launchpad opens pools.** The pool factory accepts a new pool only from the token's own NeuriioPad.
* **Fixed fee split.** Every percentage in the split is a constant in NeuriioFees. The pool's 1% fee is fixed in the
  pool code.
* **Staked tokens are yours.** NeuriioStaking has no owner and no admin function: only you can unstake your tokens or
  claim your rewards.
* **Sells can't be paused.** The emergency pause stops launches and buys only.

## What the owner can do

Some contracts have an owner, which can:

* Pause and unpause **launches and buys** in an emergency (never sells).
* Change the curve fee for future trades, up to a hard cap of **2%** (it's 1%).
* Change the starting virtual USDC for **new** launches only.
* Approve a new NeuriioPad version for new launches. Existing tokens keep trading on their own version.
* Point **future** fees at a new NeuriioFees contract. Balances already earned stay claimable in the old one.
* Reserve tickers and rotate the key that approves launches.
* Set Neuriio's minter and tune the mint rate (until it's frozen for good), and allow Neuriio to be sent between
  wallets (once, and never back).

None of these can move users' tokens, USDC, pool liquidity, staked tokens or creator balances.

{% hint style="info" %}
Before mainnet, ownership moves from a single key to a multisig, the mint rate is frozen, and the contracts get a
formal security audit.
{% endhint %}
