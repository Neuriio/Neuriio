# Safety and Contracts

Neuriio runs two contracts of its own. Tokens, their pools and trading live on **Ascend**. Every Neuriio contract will
be verified on the Elysium explorer, so anyone can read the exact code that runs.

## Contracts

| Contract | What it does | Address |
| --- | --- | --- |
| NeuriioLauncher | Checks each launch against Neuriio's rules and launches the token on Ascend; permanent record of every token and its creators | Published at mainnet launch |
| NeuriioTokenStaking | Holds staked tokens and pays stakers their share of fees in USDC | Published at mainnet launch |

Each token's pool, and the 1.5% fee on its trades, are Ascend's. See [Trading and fees](../trading/trading-and-fees.md).

## What's guaranteed by code

* **One token per X account.** The launcher records each token's X account, wallet and handle, and refuses a second
  launch from any of them.
* **Only verified launches.** A launch needs a pass signed by Neuriio after it checks the X login, so nobody can launch
  under someone else's name.
* **Profiles can't be changed.** A fingerprint (hash) of each profile is stored on-chain at launch.
* **No creator or team allocation.** The launcher gives nobody tokens; a creator's optional first buy is made in the
  pool at market, like anyone else's.
* **Staked tokens are yours.** NeuriioTokenStaking has no owner and no admin function: only you can unstake your
  tokens or claim your rewards.
* **The launcher holds no funds.**

## What Neuriio can change

The launcher's owner can pause new launches, reserve tickers that look like real assets, and change the signing key
and Ascend connection. None of these can move users' tokens, USDC or staked tokens.

{% hint style="info" %}
Before mainnet, ownership moves from a single key to a multisig, and the contracts get an external security audit.
{% endhint %}
