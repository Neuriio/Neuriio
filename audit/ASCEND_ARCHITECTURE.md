# Neuriio on Ascend: architecture

For a professional audit team starting on the contracts below. Findings are in `audit/ASCEND_SECURITY_AUDIT.md`. This replaces
`audit/ARCHITECTURE.md` for this scope; that file describes the older stack (curve, own pools, $NEURIIO token), which isn't part
of this deployment.

## 1. What changed

Neuriio is now a frontend for Ascend's launchpad on Elysium (Arbitrum Orbit L2, EVM Prague). People sign in with X and launch
through us; tokens, pools, trading and the 1% fee live on Ascend. We only need two contracts of our own.

Scope (Solidity 0.8.28, OpenZeppelin Contracts 5.4.0):

| File | nSLOC | Purpose |
|---|---:|---|
| `src/launch/NeuriioLauncher.sol` | 378 | Checks backend-signed passes and identity rules, launches through the adapter, optional first buy |
| `src/launch/IAscendAdapter.sol` | 10 | The interface between the launcher and Ascend |
| `src/stake/NeuriioTokenStaking.sol` | 134 | Stake a launched token, earn USDC |
| **Total** | **522** | |

`script/DeployAscend.s.sol` is the exact mainnet configuration; read it as the basis for access-control findings. The older
contracts stay in the repo for a later return to our own launchpad and aren't deployed in this stack.

**Not in scope, and not written yet: the real adapter.** Ascend hasn't shared its addresses or ABIs. The adapter will hold the only
code that talks to Ascend, and needs its own review.

## 2. Launch flow

```
X login -> backend verifies -> signs LaunchPass / FtfPass (15-minute deadline)
        -> creator's wallet calls NeuriioLauncher.launch / launchFtf
              1. checks the pass (signer, holder, deadline) and the rules (handle or ticker, one token each)
              2. adapter.launch(creators, name, symbol, launchData) -> token + pool on Ascend
              3. records the token
              4. optional: pulls the buyer's USDC, sends it to the adapter, adapter.firstBuy(...)
                 then checks the buyer got at least their minimum and the adapter kept no USDC
```

Everything happens in one transaction, so a launch is whole or not at all, and nobody can buy ahead of the creator's first buy.

**Identity rules.** A personal token: one per X account, per wallet and per handle (case-insensitive), named at-sign + handle, ticker =
handle in caps. An FTF ("Friends Turned Fam"): exactly 4 distinct people fixed at launch, sharing creator fees, with a ticker unique
among FTFs; being in one doesn't use up a personal launch. 19 tickers that look like real assets are reserved.

**`launchData`.** Bytes signed into the pass and handed to the adapter untouched: whatever Ascend's launch turns out to need
(metadata, a salt). It exists so the audited launcher doesn't have to change once Ascend's ABI is known. Our backend sets it, so a
creator can't choose it.

## 3. Staking and fee flow

Anyone can stake any token the launcher launched, with no lockup. Each USDC payment into a pool drips out over one hour to
whoever is staked while it drips, so catching a fee by staking for a moment earns nothing. With nobody staked, the drip waits for
the next staker. There's no owner: nobody can move staked tokens or rewards, and the launcher address is fixed at deploy.

Fees reach the contract off-chain, through `keeper/fee-router.mjs` (out of scope; described here because staking's safety relies on
how it behaves):

```
Ascend pays USDC per trade -> fee wallet (a hot key the router holds)
Router reads the transaction of each payment, finds the swap, and so the token
Hourly: 40% of each token's fees -> NeuriioTokenStaking.notifyReward(token, amount)
        60% -> treasury wallet (KNTQ buyback is done by hand from there)
        A token with no stakers sends its 40% to treasury too
```

`notifyReward` pulls USDC from its caller and is open to anyone. Stakers trust the router to divide fees correctly; both the payments
in and `RewardAdded` are public, so the split can be checked.

## 4. Roles and keys (mainnet, per `script/DeployAscend.s.sol`)

| Role | Holder | Can do | Can't do |
|---|---|---|---|
| Launcher owner | TimelockController, 48 h delay, set in the constructor | `setAdapter`, `setLaunchSigner`, `setGuardian`, `setReservedTickers`, `unpause`, transfer or renounce ownership | Touch staking, staked tokens, USDC, or anyone's approvals |
| Timelock proposer, executor, canceller | The Safe (2 of 3), and only the Safe | Schedule, run and cancel owner actions | Act faster than the delay |
| Timelock admin | The timelock itself | Change its own roles, through the delay | |
| Guardian | The Safe | `pause` at once (launches only) | Unpause or anything else |
| Launch signer | Backend hot key (Supabase secret) | Sign passes | Move any funds |
| Adapter | A contract set by the owner | Launch tokens; handle first-buy USDC while it's being spent | Pull USDC from anyone (only the launcher has approvals, and it only pulls from the caller of the launch in progress) |
| Fee wallet | Hot key held by the fee router | Whatever has arrived since the last payout | |
| Deployer | Any key | Nothing, at any point: it never holds a role | |

Staking has no roles at all.

## 5. What each contract trusts

**Launcher:** the signer (to verify X logins) and the adapter (to launch real Ascend tokens). The launcher can't tell a real Ascend
token from a fake one, so a hostile adapter could take first-buy USDC during its time plugged in. Replacing the adapter takes the
48-hour timelock, which anyone can watch.

**Staking:** the launcher's `isLaunched`, and that launched tokens are plain ERC-20s. Fee-on-transfer tokens are counted by what arrives;
rebasing tokens would break a pool's accounting, but only that pool's. Pools are isolated: a hostile or broken token can't reach
another pool's tokens or USDC. USDC is assumed to behave as bridged USDC does; if it's paused, claims wait but stakes can still leave.

**Requirements on the real adapter.** It must accept calls only from the launcher, or anyone could launch around the identity
rules. It must send the tokens and any unused USDC to the buyer, keep no USDC (the launcher enforces this), and route the deployer's
fee share to the `creators` it's given.

## 6. What Ascend still has to confirm

If any of these turn out differently, the launcher has to change and the freeze has to be redone. The adapter can absorb everything else.

1. A contract can call their launch function and be treated as the deployer.
2. A launch needs nothing paid by the creator except an optional first buy (no native fee or seed liquidity pulled from the creator).
3. A buy can run in the same transaction as the launch, through the adapter.
4. A pool is identified by a `bytes32`, such as a Uniswap v4 PoolId.
5. Tokens are plain ERC-20s.

## 7. Running the tests

```bash
forge test --no-match-path "test/fork/*"
```

Only this audit's tests: `forge test --match-path "test/audit-ascend/*"`, plus `test/NeuriioLauncher.t.sol`,
`test/NeuriioTokenStaking.t.sol` and `test/DeployAscend.t.sol`.
