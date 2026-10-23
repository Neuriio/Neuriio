# Neuriio contracts: architecture, money flows, roles and keys

Written for a professional audit team starting on the Neuriio contracts. It describes the code frozen in the commit tagged
`audit-freeze-2026-10-23` (base `ef6dce33fad60261bf31194baea7d5e520f31a2c` plus the changes listed in section 10). Line numbers refer to that working tree.
Scope: the 8 Neuriio contracts plus the Neuriio-written fee code inside the pool contract (`UniswapV2Pair.sol`:
`swap()`, `Flow`, `_feeAndK`, `_sellFee`, `_checkK`, `_takeFee`, `FeeTaken`; section 3.9). The rest of the Uniswap V2
fork is stock v2-core v1.0.1 and out of scope.
`audit/SECURITY_AUDIT.md` holds the internal audit's findings; finding IDs (`M-01`, `L-01`, `I-01`, ...) are referenced here where
a finding changes how a piece should be read.

---

## 1. What the system does

Neuriio is a token launchpad on **Elysium**, an Arbitrum Orbit chain (gas token HYPE). Every token is tied to an X
(Twitter) account:

1. **Launch.** A creator logs in with X in the Neuriio app. The backend checks the login and signs an EIP-712
   **launch pass** (`launchSigner` key). With it the creator calls `NeuriioPad.launch`, which deploys a fixed-supply
   ERC-20 (1B tokens, named `@handle`, ticker = the handle in capitals) and opens a **bonding curve** for it, priced in
   **USDC**. One personal token per X account, per wallet and per handle, forever and across every pad version.
   A group of exactly 4 people can instead launch an **FTF** ("Friends Turned Fam") token with an `FtfPass`.
2. **Curve trading.** 793.1M tokens are sold on a constant-product curve over virtual reserves
   (`virtualQuote` USDC : 1.073B tokens at launch). Every trade pays a 1% fee (`feeBps`, capped at 2%) in USDC.
3. **Graduation.** The buy that sells the last curve token creates the token's TOKEN/USDC pool on Neuriio's Uniswap V2
   fork, deposits all raised USDC plus the remaining 206.9M tokens, and burns the LP tokens. The pool opens at the
   curve's final price (to ~0.01%).
4. **Pool trading.** Pools charge 1% in USDC on every swap and send it to `NeuriioFees` inside the swap.
5. **Fees.** `NeuriioFees` splits each fee at once: to the creator(s), the treasury, the KNTQ buyback wallet, and two
   staking pools in `NeuriioStaking`.
6. **Staking.** A graduated token can be staked: its stakers earn 40% of that token's pool fees in USDC and also mint
   **$NEURIIO** (the platform token, `NeuriioPlatformToken`, 1B cap, non-transferable until the owner enables
   transfers). Staked $NEURIIO earns a share of every fee on the platform, in USDC. Rewards drip out over 1 hour.

Fee split (constants in `NeuriioFees.sol:32-38`):

| | $NEURIIO stakers | that token's stakers | creator(s) | treasury | KNTQ buyback |
|---|---|---|---|---|---|
| curve fee | 50% | - | 10% | 10% | 30% |
| pool fee | 40% | 40% | 10% | 10% | - |

A share with nobody to take it moves down the line: token stakers' share -> $NEURIIO stakers -> treasury
(`NeuriioFees._payStakers`, `:200-217`). (HANDOFF.md's 2026-10-17 paragraph and the audit request still say "curve: 80%
stakers / 10% buyback / 10% treasury"; the code follows the later decision of 2026-10-20. See finding I-01.)

$NEURIIO mint (`NeuriioMinter`, frozen at deploy): 10 $NEURIIO per $1 that X-token stakers earn (the deploy default
since 2026-10-23; the code caps it at 25), flat until $1M of total
platform fees, then `25 x (S / (S + h))^2` with `h` = platform fees past $1M and `S` = $120M; hard cap 1B (the last mint
is cut to what's left).

---

## 2. Contracts

### In scope (Solidity 0.8.28, OpenZeppelin 5.4.0)

| Contract | Lines | Owner on mainnet | Holds | One-line role |
|---|---|---|---|---|
| `src/launch/NeuriioPad.sol` | 609 | Timelock | every live curve's USDC and unsold tokens | launches, curve trading, graduation, pause |
| `src/launch/NeuriioFees.sol` | 234 | Timelock | creators' unclaimed fees, treasury + buyback balances | fee intake, split, payouts |
| `src/launch/NeuriioRegistry.sol` | 169 | Timelock | nothing | permanent identity registry, approved pad versions |
| `src/launch/NeuriioToken.sol` | 15 | none | nothing | the launched ERC-20 |
| `src/stake/NeuriioStaking.sol` | 248 | none | staked tokens, staked $NEURIIO, USDC + $NEURIIO rewards | staking pools with 1-hour drips |
| `src/stake/NeuriioMinter.sol` | 114 | Timelock (locked) | nothing | the $NEURIIO mint curve |
| `src/stake/NeuriioPlatformToken.sol` | 72 | Timelock (minter locked) | nothing | $NEURIIO |
| `src/swap/NeuriioRouter.sol` | 179 | none | nothing between calls | the app's single entry point for trades |
| `src/swap/v2/UniswapV2Pair.sol`, Neuriio parts only (0.5.16): `swap()` `:165-188`, `FeeTaken` `:65`, `:203-273` | ~90 | none | each pool's USDC and tokens (LP burned) | the 1% pool fee in USDC, its K check, and the hand-off to NeuriioFees (section 3.9) |

### Out of scope, but called by / calling the above

| Contract | Role | How it touches the in-scope code |
|---|---|---|
| `src/swap/v2/UniswapV2Factory.sol` (0.5.16 fork) | creates TOKEN/USDC pairs | `createPair` only if `msg.sender == registry.launchpadOf(token)` (`:38`); holds `quote` (USDC, set once), `feeVault` (NeuriioFees; the pair reads it on every swap), `registry` (set once); admin = `feeToSetter` (the timelock) |
| the rest of `src/swap/v2/UniswapV2Pair.sol` (stock V2) | the pools' liquidity and reserves | `mint` (graduation deposits here, LP to `DEAD`), `burn`, `_mintFee`, `skim`, `sync`, `_update`, the `lock` modifier |
| `src/swap/interfaces.sol` | shared interfaces | `ISwapPair`, `ISwapFactory`, `ISwapFactoryAdmin` |
| OpenZeppelin `TimelockController` | owner of everything | 48 h delay; the Safe is its only proposer, canceller and executor; self-administered |
| Safe v1.3.0 (2-of-3) | operators | proposes/executes timelock operations; the pad's `guardian` |
| USDC (bridged, 6 decimals) | the quote token | every price, fee and reward |

---

## 3. Contract by contract

### 3.1 NeuriioPad (`src/launch/NeuriioPad.sol`)

One replaceable version of the launchpad. It holds **every live curve's USDC in one balance** and accounts per curve.

State per token (`Curve`, `:108-115`): `creator`, `graduated`, `virtualQuote`, `virtualToken`, `realQuote` (USDC raised
and held), `realToken` (curve tokens unsold). Global: `virtualQuote` (for new launches), `feeBps`, `feeVault`,
`launchSigner`, `guardian`, `factory`/`quote`/`registry` (immutable).

Entry points:
- `launch(pass, sig, quoteIn, minOut)` (`:211`) / `launchFtf(...)` (`:236`), `whenNotPaused`, `nonReentrant`: check
  deadline, `msg.sender == pass.creator` (FTF: `== founder == members[0]`), `ECDSA.recover(digest) == launchSigner`,
  field rules (`_checkHandle` `:541`, `_checkMembers` `:559`, `_checkFtfName` `:569`, `_checkFtfTicker` `:582`); deploy
  the token (`_newCurve` `:430`, all 1B minted to the pad); register in the registry (uniqueness enforced there);
  optional atomic first buy.
- `buy(token, quoteIn, minOut, deadline)` (`:260`), `whenNotPaused`: `_buy` (`:444`): the fee comes off the top
  (`_fee(quoteIn, false)` = floor(quoteIn x fee / (10000 + fee))), tokens out =
  `vt - ceil(vq * vt / (vq + net))`; if that reaches the unsold amount, the buy is capped to exactly `realToken`, net =
  `ceil(vq * vt / (vt - realToken)) - vq`, fee = ceil(net x fee / 10000) (never more than offered); pull `net + fee`,
  send tokens, pay the fee, graduate when `realToken == 0`.
- `sell(token, tokensIn, minOut, deadline)` (`:272`), **not** pausable: gross = `vq - ceil(vq * vt / (vt + tokensIn))`
  capped at `realQuote`, fee = ceil(gross x fee / 10000), pays `gross - fee`.
- `_payFee` (`:465`): `quote.safeTransfer(feeVault, fee)` then `feeVault.notifyCurveFee(token)`. A revert here reverts
  the trade, sells included (finding L-01).
- `_graduate` (`:472`): `factory.createPair`, `skim(DEAD)` (clears anything sent to the predictable pair address
  beforehand), transfer `LP_SUPPLY` tokens + `realQuote` USDC, `mint(DEAD)`.
- Views: `previewBuy`, `previewSell`, `quoteToGraduate`, `price`, `hashLaunchPass`, `hashFtfPass`, profile getters.
- Owner: `setVirtualQuote` (1 USDC .. uint96 max, new launches only), `setFee` (<= 200 bps, all curves),
  `setFeeVault` (any non-zero address; one without code makes every fee-paying trade revert), `setLaunchSigner`
  (0 stops launches), `setGuardian`, `unpause`.
  Owner **or guardian**: `pause()` (stops launches and buys, so graduations; sells stay open).

EIP-712: domain `("Neuriio Launchpad", "1", chainId, address(this))`. Types (`:57-62`):
`LaunchPass(address creator,uint64 xUserId,string handle,uint8 category,bytes32 profileHash,uint256 deadline)` and
`FtfPass(address founder,string name,string ticker,uint64[4] memberXIds,address[4] members,bytes32 profileHash,uint256 deadline)`.
Passes carry **no nonce**: single use comes from the registry's uniqueness rules (one token per X id / wallet / handle;
one FTF per ticker). The backend signs with a 15-minute deadline (`PASS_TTL_SECONDS` in
`supabase/functions/_shared/launchPass.ts`).

Curve numbers: `TOTAL_SUPPLY` 1B, `CURVE_SUPPLY` 793.1M, `LP_SUPPLY` 206.9M, `VIRTUAL_TOKENS` 1.073B. With the launch
virtual reserve `V`, graduation raises ~2.8335 V and the market cap at graduation is ~13.7 V (testnet runs V = 6,000
USDC; mainnet's `VIRTUAL_QUOTE` is a deploy-day input).

Compiled with 200 optimizer runs (EIP-170 size; `foundry.toml`).

### 3.2 NeuriioFees (`src/launch/NeuriioFees.sol`)

Receives every fee as **a USDC transfer followed by a notify that names the amount**, and credits exactly that amount
(`_intake`), reverting `FeeNotReceived` if the vault doesn't hold it above `held`. USDC that reaches it any other way
is nobody's fee, mints nothing, and anyone can `sweep()` it to the treasury wallet.

- `notifyCurveFee(token, amount)`: only `registry.launchpadOf(token)` (any pad version, approved or retired).
- `notifyPoolFee(token, amount)`: only `factory.getPair(token, USDC)`.
- `_intake`: treasury 10%, creator 10%, then holders 40% (pool) or buyback 30% (curve), stakers = the remainder;
  creators credited to `creatorBalance` (FTF: 4 equal shares, remainder to the founder); stakers' shares handed to
  `NeuriioStaking.notifyReward` (staking **pulls** the USDC; NeuriioFees gave it a max approval in the constructor);
  a share staking can't take (nobody staked, or the call fails: both inside `try`) moves down the line; then
  `minter.onFee(token, fee, holdersPaid)` inside `try`.
- `held` = `sum(creatorBalance) + treasuryBalance + buybackBalance`; `claim(to)` (creator, to any address),
  `payProtocol()` (anyone; pays the current treasury and buyback wallets) and `sweep()` (anyone; unreported USDC to the
  treasury) are the only outflows besides staking's pulls.
- Owner: `setWallets(treasury, buyback)`. The split itself is constant: changing it means a new NeuriioFees.

### 3.3 NeuriioRegistry (`src/launch/NeuriioRegistry.sol`)

The permanent core of launching, deployed once. Records, for every token any pad version launches: `launchpadOf`,
`isFtf`, `creatorsOf` (1 creator, or 4 FTF members founder first). Uniqueness maps: `tokenOfXUser`, `tokenOfCreator`,
`tokenOfHandle` (keccak of the lower-case handle), `tokenOfFtfTicker`; `reservedTicker` (19 built in, `:45-65`).
Personal tickers and FTF tickers are **separate namespaces** (finding I-03). There is **no way to unregister** anything.

- `registerPersonal` / `registerFtf`: only approved pads (`isLaunchpad`); the pad is trusted for every argument.
- Owner: `setLaunchpad(pad, approved)` (revoking only stops new launches; existing tokens keep trading, graduating and
  earning, because every check uses `launchpadOf`), `setReservedTickers` (hashes the string as given, finding I-04).

### 3.4 NeuriioToken (`src/launch/NeuriioToken.sol`)

Plain OpenZeppelin ERC-20, 18 decimals, whole supply minted once to the deploying pad, no owner, no hooks, no fees.

### 3.5 NeuriioStaking (`src/stake/NeuriioStaking.sol`)

No owner. One pool per token: `$NEURIIO`, or any token that has a pair in the factory (i.e. a graduated Neuriio
token; `isStakeable`, `:164`). Each pool has two reward streams (USDC, $NEURIIO), each a `Drip`
(`rate`, `acc`, `lastUpdate`, `end`).

- `stake` / `unstake` / `claim(tokens, to)`, `nonReentrant` (transient). `stake` credits the balance actually received.
  `claim` sends USDC to `to` and **auto-stakes** claimed $NEURIIO into the caller's $NEURIIO position (no transfer:
  the minted $NEURIIO already sits in this contract).
- `notifyReward(token, amount)`: **anyone**; pulls `amount` USDC from the caller and adds it to the drip. Every call
  restarts the drip: what's left plus the new amount drips over the next hour (`_addToDrip`, `:223`; finding I-06).
- `notifyNeuriio(token, amount)`: only `neuriio.minter()`, never for the $NEURIIO pool.
- Accounting: reward-per-token `acc` scaled by 1e36, drip `rate` by 1e18; while a pool has nothing staked its drip is
  paused (`end` moves out), so the remainder goes to the next stakers (`_updateDrip`, `:209`). All rounding is down.
- Deploys `NeuriioPlatformToken` in its constructor and is that token's `staking` address.

### 3.6 NeuriioMinter (`src/stake/NeuriioMinter.sol`)

Only approved vaults (`isVault`) call `onFee(token, fee, toHolders)` (`:56`): mints
`min(toHolders in dollars x rateNow(), cap - supply)` $NEURIIO to NeuriioStaking and calls `notifyNeuriio`; then
`totalFees += fee` (dollars x 1e18; curve fees count too). Owner: `setVault` (adding refused after `lockVaults`;
removing always allowed), `setMintCurve` (refused after `freezeMintCurve`, never above 25/$1). On mainnet both locks are
on and the only vault is the one NeuriioFees, so **a replacement NeuriioFees can never mint** (finding I-02).

### 3.7 NeuriioPlatformToken (`src/stake/NeuriioPlatformToken.sol`)

$NEURIIO: OZ ERC-20, `MAX_SUPPLY` 1B, `mint` only by `minter` (locked to NeuriioMinter on mainnet). `allowance()` is
overridden to return max for NeuriioStaking for every holder (so staking needs no approval). Until `enableTransfers()`
(owner, one-way), `_update` refuses any move that isn't a mint or made by NeuriioStaking.

### 3.8 NeuriioRouter (`src/swap/NeuriioRouter.sol`)

No owner, no funds between calls. `buy` / `sell` route to the token's own pad (looked up in the registry) while it has
no pair, and to the pair after graduation (`factory.getPair`). Curve path: pulls from the user, gives the pad a standing
max approval (USDC and that token), calls the pad, forwards the output and refunds unspent USDC (a graduating buy uses
only what's needed). Pool path: transfers straight from the user to the pair and swaps to `msg.sender`; buys use V2
math with a 1% input fee (`getAmountOut`), sells pay 99% of V2's no-fee output (`getSellAmountOut`).
Users approve the router once, unlimited (the app does this silently on the first trade of each token).

### 3.9 The pool's fee code (`src/swap/v2/UniswapV2Pair.sol`, Neuriio-written parts, Solidity 0.5.16)

`swap(amount0Out, amount1Out, to, data)` keeps V2's flow: send the outputs, run the flash-swap callback
`uniswapV2Call` if `data` is non-empty (`:178`), read both balances, take each input as the balance above
`reserve - out`, then `_feeAndK` (`:185`) and `_update` with the balances `_feeAndK` returns. The `lock` modifier is
held throughout, so nothing can re-enter `swap`, `skim`, `sync`, `mint` or `burn` of that pair, including from the
callback or from NeuriioFees.

`_feeAndK` (`:222`) maps the swap into a `Flow` (`:213`): `y`/`x` = USDC/token balance after the trader's flows,
`quoteIn`/`tokenIn` = the inputs; reserves `R_q`, `R_t` are still the pre-swap ones. Then:
- `_sellFee` (`:241`): if tokens came in and USDC went out (`out = R_q + quoteIn - y`), `sellFee = ceil(out / 99)`,
  else 0.
- `_checkK` (`:249`), exact in 1/10000ths: `(y - quoteIn/100 - sellFee) x (x - tokenIn/100 if sellFee == 0, else x)
  >= R_q x R_t`.
- `_takeFee` (`:262`): `fee = floor(quoteIn/100) + (sellFee if > 0, else floor(floor(tokenIn/100) x (y - floor(quoteIn/100)) / x))`;
  if `factory.feeVault()` is set and `fee > 0`: transfer `fee` USDC to it, call `notifyPoolFee(token, fee)`, emit
  `FeeTaken`; the returned balance is `y - fee`, so reserves are set from post-fee balances. With no vault set the fee
  stays in the pool, like V2.

| Path | Trader's flows | Fee to NeuriioFees (USDC) | What the K check deducts |
|---|---|---|---|
| buy | USDC in, tokens out | floor(1% of USDC in) | 1% of the USDC input |
| sell | tokens in, USDC out | ceil(out / 99), i.e. 1% of out + fee | the fee, from the USDC side |
| USDC flash swap | USDC out, USDC back | floor(1% of USDC back) | 1% of the USDC input |
| token flash swap | tokens out, tokens back | 1% of the tokens back, at the post-swap price | 1% of the token input |
| anything with USDC out and tokens in | e.g. a token flash swap that also takes dust USDC out (finding L-02) | the sell formula | the sell formula |

K never drops on any path (argument in the comments at `:256-261`; fuzzed in `test/audit/AuditPool.t.sol`). Pairs
without USDC can't exist (the factory refuses them); `_feeAndK` would treat token0 as the quote and take nothing.

Interactions: during `notifyPoolFee` the pair's views still show the pre-swap reserves (no Neuriio contract reads
them); a reverting vault reverts every swap of every pool (finding L-01; the factory's `setFeeVault(0)` is the
switch back, through the timelock); swap fees leave the pool, so liquidity providers (only `DEAD` after graduation, or
anyone who adds liquidity later) and V2's `feeTo` share (`_mintFee`) see only rounding dust. `skim` and `sync` are
stock V2: a balance above the reserve counts as input to the next swap (and pays its 1%).

The router's pool math matches the pair: `getAmountOut` is V2's formula with 1% off the input, the largest buy output
the K check accepts; `getSellAmountOut` is `floor(0.99 g)` with `g = floor(in x R_q / (R_t + in))`, the largest sell
output the check accepts (`floor(0.99 g) + ceil(floor(0.99 g) / 99) <= g`, and one more base unit would exceed it).

---

## 4. Lifecycle of a token

```
            launch / launchFtf (pass signed by launchSigner)
                       |
                       v
   +---------------------------------------+     pause(): no launches, no buys (so no graduation);
   | CURVE  (NeuriioPad.curves[token])     |     sells stay open
   |  buy  -> fee -> NeuriioFees (curve)   |
   |  sell -> fee -> NeuriioFees (curve)   |
   +---------------------------------------+
                       | the buy that sells the last of the 793.1M curve tokens
                       v
     _graduate: createPair -> skim(DEAD) -> 206.9M tokens + all raised USDC -> mint LP to DEAD
                       |
                       v
   +---------------------------------------+
   | POOL (UniswapV2Pair, no owner)        |     staking opens (a pair exists)
   |  swap -> 1% USDC -> NeuriioFees (pool)|     not pausable
   +---------------------------------------+
```

A token is never on the curve and in a pool at once: graduation closes the curve (`graduated = true`) and creates the
pair in the same transaction, and the router picks the venue by whether the pair exists.

---

## 5. Money flows

### USDC

```
 trader --(net+fee)--> NeuriioPad --(fee)--> NeuriioFees          curve buy (via router: trader -> router -> pad)
 trader <--(gross-fee)-- NeuriioPad --(fee)--> NeuriioFees        curve sell
 NeuriioPad --(all raised USDC)--> pair                           graduation (LP tokens -> 0x...dEaD)
 trader --(USDC in)--> pair --(1% of USDC in)--> NeuriioFees      pool buy
 trader <--(99% of V2 out)-- pair --(out/99, rounded up)--> NeuriioFees      pool sell

 NeuriioFees: credits balance - held, then
   --(token stakers 40%, $NEURIIO stakers 40/50%)--> NeuriioStaking   (staking pulls, same tx)
   creatorBalance += 10%      --claim(to)-->   creator's chosen address
   treasuryBalance += 10%     --payProtocol()--> treasury wallet (anyone can call)
   buybackBalance += 30%      --payProtocol()--> buyback wallet

 NeuriioStaking: drips over 1 h --claim(tokens, to)--> USDC to `to`
```

### Tokens

Launched tokens: minted 1B to the pad; leave it only by curve buys and graduation (`LP_SUPPLY` to the pair); return to
it by curve sells. Staked tokens sit in NeuriioStaking until their owner unstakes.

### $NEURIIO

```
 NeuriioFees._intake --onFee(token, fee, holdersPaid)--> NeuriioMinter --mint--> NeuriioStaking
   --notifyNeuriio(token)--> drips to that token's stakers --claim--> auto-staked in the $NEURIIO pool
   --unstake--> the holder's wallet (cannot be sent on until enableTransfers())
```

---

## 6. Roles and keys on mainnet

Configuration from `script/DeployMainnet.s.sol` (`_deploy` `:109-174`, verified on-chain by `check` `:177-210`, run
end to end by `test/DeployMainnet.t.sol` and against Safe's real contracts by `test/fork/Rehearsal.t.sol`).

| Actor | Key / control | Powers |
|---|---|---|
| **Safe** (2-of-3, hardware wallets on separate devices) | 2 of 3 owner signatures (`approveHash` flow, `/safe` page) | the timelock's only **proposer, canceller and executor**; the pad's **guardian** (instant `pause()`); suggested treasury + buyback wallet |
| **TimelockController** (48 h) | the Safe, after the delay | owner of NeuriioRegistry, NeuriioPad, NeuriioFees, NeuriioMinter, NeuriioPlatformToken; the factory's `feeToSetter`; its own admin (role or delay changes also wait 48 h) |
| **Launch signer** | hot backend key (Supabase secret `LAUNCH_SIGNER_KEY`) | authorises every launch: any X id, handle, wallet and FTF; no on-chain limit, rate or revocation besides the 15-min deadline it sets itself (finding M-01) |
| Treasury wallet, buyback wallet | set by `NeuriioFees.setWallets` | receive `payProtocol()` |
| Payout bot | gas-only wallet on EC2 | calls the permissionless `payProtocol()` hourly; no privileges |
| Creators / FTF members | their wallets | `NeuriioFees.claim`; fixed forever per token |
| Deployer | throwaway | **nothing** after the script (checked by `check()`) |
| External: USDC issuer | issuer's admin keys | pause, blacklist, upgrade USDC (findings L-01, I-07) |
| External: Elysium operator | chain admin / sequencer | transaction ordering, censorship, chain upgrades |

### Every privileged function

"Timelock" means: the Safe schedules, then executes after 48 h; anyone can see the operation on-chain while it waits.

| Contract.function | Caller on mainnet | What it can do at worst | Reversible? |
|---|---|---|---|
| NeuriioPad.pause | Safe (guardian) at once, or timelock | stop launches, buys and graduations on every curve (sells stay open) | yes, by `unpause` (timelock, 48 h) |
| NeuriioPad.unpause | timelock | resume | yes |
| NeuriioPad.setFee | timelock | fee up to 2% on every curve trade | yes |
| NeuriioPad.setVirtualQuote | timelock | starting reserve of new launches (1 USDC .. uint96 max) | yes (new launches only) |
| NeuriioPad.setFeeVault | timelock | send curve fees anywhere; a reverting vault blocks every curve buy **and sell** (L-01) | yes, 48 h later |
| NeuriioPad.setLaunchSigner | timelock | a malicious signer can register any identity, permanently (M-01); `0` stops launches | future launches only |
| NeuriioPad.setGuardian | timelock | change or remove who can pause at once | yes |
| NeuriioRegistry.setLaunchpad | timelock | approve a pad version that can register any identity or token address, create its tokens' pools and receive its tokens' fees | future registrations only; registrations are permanent |
| NeuriioRegistry.setReservedTickers | timelock | (un)reserve tickers for new launches | yes |
| NeuriioFees.setWallets | timelock | redirect treasury + buyback income, including balances accrued but not yet paid out | yes |
| NeuriioMinter.setVault(v, false) | timelock | stop $NEURIIO minting for good (a vault can't be re-added after `lockVaults`) | **no** |
| NeuriioMinter.setVault(v, true) / setMintCurve | — | refused: `lockVaults` / `freezeMintCurve` are on | — |
| NeuriioPlatformToken.enableTransfers | timelock | make $NEURIIO transferable | **no** (one-way) |
| NeuriioPlatformToken.setMinter | — | refused: `lockMinter` is on | — |
| UniswapV2Factory.setFeeVault | timelock (feeToSetter) | send pool fees anywhere; a reverting vault blocks every pool swap of every graduated token (L-01); `0` leaves fees in the pools | yes, 48 h later |
| UniswapV2Factory.setFeeTo | timelock | V2's LP fee switch (1/6 of sqrt(k) growth; negligible because fees leave the pools) | yes |
| UniswapV2Factory.setFeeToSetter | timelock | hand pool admin to another address (one step) | depends on the new holder |
| `renounceOwnership` (every Ownable2Step contract) | timelock | freeze that contract's settings forever (a pad paused after renouncing can never be unpaused) | **no** |
| `transferOwnership` / `acceptOwnership` | timelock | move ownership (two-step) | yes |
| TimelockController role / delay changes | timelock itself | change who runs the timelock, or the delay | yes, through the timelock |

Nobody can move users' staked tokens, staked $NEURIIO, unclaimed staking rewards or creators' unclaimed fees: those
contracts (NeuriioStaking) have no owner, and NeuriioFees' owner can only change the protocol wallets. The worst a
compromised Safe can reach, after a public 48 h wait, is **blocking** trading (the curves' USDC and the pools stay
where they are) and redirecting fee income (findings M-01 and L-01).

---

## 7. Trust assumptions the code relies on

1. **USDC** has 6 decimals, no transfer hooks, no fee-on-transfer, and no rebasing. It may be Circle's FiatToken:
   pause and blacklist reach Neuriio directly (finding L-01, I-07).
2. **The stock parts of the V2 fork** (out of scope): only a token's own pad can create its pair; every pair is
   TOKEN/USDC; a fresh pair has zero reserves, so `skim` empties it; `mint` to `DEAD` burns the liquidity; the `lock`
   modifier holds for the whole swap. (The pair's fee hand-off, `_takeFee` -> `notifyPoolFee`, is in scope: 3.9.)
3. **The backend** signs only verified identities, keeps FTF tickers unique among concurrent passes, uses short
   deadlines, and keeps the signer key safe (no on-chain limit applies to it).
4. **The Safe signers** keep 2 of 3 keys available (the timelock's only executor is the Safe: losing 2 keys freezes
   every admin action, including `unpause`).
5. **The chain** supports transient storage (EIP-1153; `ReentrancyGuardTransient` in NeuriioFees, NeuriioStaking,
   NeuriioRouter) and the `prague` EVM target.

---

## 8. Upgrade model

- **Permanent:** NeuriioRegistry, the V2 factory and its pairs, NeuriioStaking (with $NEURIIO), NeuriioMinter.
  They hold the identities, the pools, the stakes and the mint; none can be swapped out.
- **Replaceable pad:** a new NeuriioPad is approved in the registry; the old one keeps serving its own curves (fees,
  graduation and pairs all key off `launchpadOf`, not approval). Identity rules span versions.
- **Replaceable fee vault:** `NeuriioPad.setFeeVault` + factory `setFeeVault`. Old balances stay claimable in the old
  vault. After `lockVaults`, a new vault can't mint $NEURIIO (finding I-02).
- **Router:** stateless; the app can point at a new one (users re-approve).

---

## 9. Invariants we expect to hold (and test)

1. Pad solvency: USDC(pad) >= sum of `realQuote` over live curves; token balance of the pad >= `LP_SUPPLY + realToken`
   for each live curve.
2. Curve: `virtualQuote x virtualToken` never decreases; `virtualQuote - realQuote` = the curve's launch reserve;
   `virtualToken - realToken` = `VIRTUAL_TOKENS - CURVE_SUPPLY`.
3. NeuriioFees: USDC(vault) >= `held` = sum(`creatorBalance`) + `treasuryBalance` + `buybackBalance`; every fee's shares
   add up to the fee exactly.
4. Staking: USDC(staking) >= everything owed, accrued and still dripping; $NEURIIO(staking) >= staked $NEURIIO + all
   $NEURIIO rewards owed, accrued and dripping.
5. $NEURIIO: `totalSupply <= 1B`; minted only through `NeuriioMinter.onFee`; no holder-to-holder transfer while
   `transferable == false`.
6. Identity: one personal token per X id, per wallet and per case-insensitive handle, across all pad versions; FTF
   tickers unique among FTFs; reserved tickers refused.
7. Only a token's own pad creates its pool; it opens at ~the curve's final price; its LP is burned.
8. A pause never blocks a sell (subject to the fee vault and USDC, finding L-01).

---

## 10. Code under audit

- Base: `ef6dce33fad60261bf31194baea7d5e520f31a2c` (branch `main`).
- Changes on top of the base, all in the freeze commit: `NeuriioPad` (guardian + `pause` by owner or guardian, comments),
  `NeuriioMinter` (`lockVaults`, `vaultsLocked`), `NeuriioStaking` (comments only), `NeuriioRouter`
  (`getSellAmountOut`: pool sells pay 1% of the sale), `interfaces.sol` (comment), the fork's `UniswapV2Pair`
  (`_feeAndK`, sell fee), new `script/DeployMainnet.s.sol`, `script/CreateSafe.s.sol`, `script/SafeTx.s.sol`, and tests;
  after the audit (M-02): `NeuriioFees` credits only the fee the pad or pair reports (`notifyCurveFee(token, amount)`,
  `notifyPoolFee(token, amount)`, `sweep()`), and the deploy default mint rate is 10 per $1 (`script/NeuriioConfig.sol`).
- Toolchain: Foundry 1.5.1, solc 0.8.28 (0.5.16 for `src/swap/v2`), OpenZeppelin Contracts 5.4.0, optimizer 10,000 runs
  (NeuriioPad 200), `evm_version = "prague"`.
- Build and test: `forge build`; `forge test --no-match-path "test/fork/*"` (unit, fuzz and the audit's tests in
  `test/audit/`); the fork rehearsal needs network: `FORK=true forge test --match-path test/fork/Rehearsal.t.sol -vv`.
