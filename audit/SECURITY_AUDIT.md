# Neuriio internal security audit (pre-mainnet)

Date: 2026-10-22/23. Internal audit before the code freeze for the outside audit firm. Companion document:
`audit/ARCHITECTURE.md` (contracts, money flows, every role and key on mainnet).

## 1. Scope

The 8 Neuriio contracts (Solidity 0.8.28, OpenZeppelin Contracts 5.4.0), 1,640 lines:

| File | Lines |
|---|---|
| `src/launch/NeuriioPad.sol` | 609 |
| `src/launch/NeuriioFees.sol` | 234 |
| `src/launch/NeuriioRegistry.sol` | 169 |
| `src/launch/NeuriioToken.sol` | 15 |
| `src/stake/NeuriioStaking.sol` | 248 |
| `src/stake/NeuriioMinter.sol` | 114 |
| `src/stake/NeuriioPlatformToken.sol` | 72 |
| `src/swap/NeuriioRouter.sol` | 179 |

Added to the scope by the user on 2026-10-23: the Neuriio-written fee code of the pool contract
`src/swap/v2/UniswapV2Pair.sol` (Solidity 0.5.16): `swap()` (lines 165-188), the `FeeTaken` event (line 65), and
`struct Flow`, `_feeAndK`, `_sellFee`, `_checkK`, `_takeFee` (lines 203-273). The rest of the pair and the factory are
stock Uniswap V2 (v2-core v1.0.1) and were read only where the fee code interacts with them (`mint`, `burn`,
`_mintFee`, `skim`, `sync`, `_update`, the factory's `quote()` / `feeVault()`).

Code version: the audit was run on `ef6dce33fad60261bf31194baea7d5e520f31a2c` **plus the then-uncommitted working
tree**; everything, including the M-02 changes, is frozen in the commit tagged `audit-freeze-2026-10-23`. The working
tree added: `NeuriioPad` (guardian, `pause` by owner or guardian), `NeuriioMinter` (`lockVaults`), `NeuriioStaking`
(comments), `NeuriioRouter` (`getSellAmountOut`), `src/swap/interfaces.sol` (comment), and, out of scope but read for
context, the fork's `UniswapV2Pair` (pool sells pay 1% of the sale) and the new `script/DeployMainnet.s.sol`. Line
numbers below refer to that working tree.

Out of scope (the user's call): the rest of the Uniswap V2 fork in `src/swap/v2/`, `src/testnet/`, the scripts and
all off-chain code. They were read only to understand how they call the in-scope code; where Neuriio's safety rests
on them, the assumption is stated (section 6). `script/DeployMainnet.s.sol` was read as the
exact mainnet configuration, and access-control findings are judged against it.

## 2. Method

1. Lead review: every in-scope line read by the lead auditor, plus the fork's calls into Neuriio, the deploy script,
   the existing 88 tests and the backend's pass-signing types (`supabase/functions/_shared/launchPass.ts`).
2. The lead review covered each angle in turn, with tests: attacker (theft, locking, griefing, power), accounting
   (handler-based invariant fuzzing of every balance and fee split, plus fuzzing at the edges of every setting),
   state machine and access control (the mainnet configuration, the locks, reentrancy, USDC's ERC-20 quirks),
   signatures and integration (EIP-712 against an independent encoder, replay, malleability, the contracts' calls into
   each other), and the pool's fee code once it joined the scope (fuzz of every shape of direct swap).
3. Separate review passes per angle were planned on Fable, then on Opus; they were stopped before reporting (Fable ran
   out of credits; the user then judged them overkill for 8 contracts). Every finding below comes from the lead review
   and is reproduced by a Foundry test in `test/audit/`.
4. Tools: Foundry 1.5.1 (unit, fuzz and handler-based invariant tests; `vm.eip712HashTypedData` as an independent
   EIP-712 encoder). Slither and Aderyn were not used: they aren't installed and installing packages was ruled out
   (supply-chain caution); the outside firm should run them, along with its own independent review.

Run everything: `forge test --no-match-path "test/fork/*"`; only the audit's tests: `forge test --match-path "test/audit/*"`.

## 3. Threat model

Assets: USDC held by NeuriioPad for every live curve; tokens on the curves; pool liquidity (LP burned, so it can never
be withdrawn); staked tokens and staked $NEURIIO; unclaimed USDC and $NEURIIO rewards; creators' unclaimed fees;
the treasury and buyback balances; the identity namespace (one token per X account, wallet and handle, forever);
the $NEURIIO supply and its 1B cap.

Actors considered:
- Unprivileged attackers with large capital, flash swaps (the pools), contracts and EIP-7702 accounts.
- Transaction ordering: Elysium's sequencer orders first-come-first-served; MEV and sequencer-level reordering were
  still assumed possible.
- Malicious creators and FTF members.
- A leaked **launch signer** key (a hot key held by the backend).
- A compromised **Safe** (2 of 3 keys) acting through the 48 h timelock, and as guardian.
- The **USDC issuer** (pause, blacklist, upgrade) and the chain operator, as external dependencies.

Mainnet configuration assumed (from `script/DeployMainnet.s.sol`, checked on-chain by its `check()`): a
TimelockController with a 48 h delay owns NeuriioRegistry, NeuriioPad, NeuriioFees, NeuriioMinter and
NeuriioPlatformToken and is the V2 factory's `feeToSetter`; the 2-of-3 Safe is its only proposer, canceller and
executor and the pad's guardian; `lockVaults`, `freezeMintCurve` and `lockMinter` are on; the deployer keeps nothing.

Severity: **Critical**: an unprivileged attacker steals or permanently locks user funds, or takes over the protocol.
**High**: significant loss or lock of funds, or a core guarantee broken, under realistic conditions. **Medium**: bounded
loss, a core guarantee broken under specific conditions (e.g. a leaked hot key), or value extraction from other users.
**Low**: minor loss, edge cases, or behaviour that contradicts the docs without loss. **Info**: design notes, docs,
code quality.

## 4. Summary of findings

| ID | Title | Severity | Status |
|---|---|---|---|
| M-01 | A leaked launch-signer key squats X identities permanently; the only fast stop halts all buying | Medium | Open |
| M-02 | $NEURIIO can be farmed by self-dealing (~2.5 cents each by wash trading at the launch rate) | Medium | Partly fixed; rest accepted |
| L-01 | A failing fee vault blocks curve sells and pool swaps, so "holders can always exit" depends on it | Low | Open |
| L-02 | A token flash swap skips its 1% pool fee by also taking 1 base unit of USDC out | Low | Open |
| I-01 | Curve fee split: the audit request and part of HANDOFF.md say 80/10/10, the code says 50/30/10/10 | Info | Confirm intent |
| I-02 | After `lockVaults`, a replacement NeuriioFees can never mint $NEURIIO | Info | Design note |
| I-03 | Personal and FTF tickers are separate namespaces (an FTF can copy `$ALICE`) | Info | Open |
| I-04 | `setReservedTickers` is case-sensitive (reserving "pump" does nothing) | Info | Open |
| I-05 | Buys of 100 base units or less pay no fee | Info | Accept |
| I-06 | Anyone can restart a reward drip with 1 base unit (exponential tail instead of 1 hour) | Info | Accept / document |
| I-07 | USDC issuer dependencies (pause; blacklisting 0x...dEaD blocks every graduation) | Info | Document |
| I-08 | `setFeeVault` accepts any non-zero address; `renounceOwnership` is available everywhere | Info | Open |
| I-09 | Stray funds: USDC sent to the pad, router or staking is stuck; sent to NeuriioFees it is credited as fees | Info | Document |
| I-10 | Stale comments and names (fee split in `test/NeuriioStaking.t.sol`, "100 per $1", HANDOFF.md) | Info | Open |

No Critical or High issue was found.

## 5. Findings

### M-01 A leaked launch-signer key squats X identities permanently; the only fast stop halts all buying

Severity: Medium. Likelihood is low but real (the key is a hot key in the backend's secrets: any backend or Supabase
compromise leaks it); the impact breaks the product's core promise, permanently, and opens a scam vector.

Where:
- `src/launch/NeuriioPad.sol:217-227` and `:242-252`: any pass the key signs is accepted, for any X id, handle, wallet
  or FTF; passes have no nonce and nothing limits how many can be used per block.
- `src/launch/NeuriioRegistry.sol:80-113`: registrations are permanent across every pad version; there is no
  function to release an X id, handle or wallet.
- `src/launch/NeuriioPad.sol:406-408`: rotating the signer is `onlyOwner`, i.e. 48 h through the timelock.
- `src/launch/NeuriioPad.sol:418-421`: the guardian's only power, `pause()`, also stops every buy and graduation.

Failure scenario: an attacker gets `LAUNCH_SIGNER_KEY`. Within one block they sign passes for the 1,000 best-known X
accounts, each to a wallet they control, and launch them (optionally with a dev buy at the starting price). Buyers
see "@famousperson" tokens that look verified. The Safe needs two signers to react; when it pauses, every buy on every
honest token stops too, and unpausing waits 48 h. Rotating the signer also waits 48 h. Afterwards the real people can
never launch on any pad version, and the attacker keeps those tokens' creator fees forever.

Reproduction: `test/audit/AuditOwn.t.sol` -> `test_leakedSignerSquatsIdentitiesForever` (mainnet configuration: 25
identities launched in one block; the Safe's pause blocks an honest buy; the rotation is refused before 48 h; with the
new key on a brand-new pad version the real account's valid pass reverts `AlreadyLaunched`, under its handle and under
another one).

Suggested fix (any combination):
1. Let the guardian stop launches without stopping trading: e.g. guardian may call `setLaunchSigner(address(0))` (only
   to zero), or a separate `launchesPaused` flag the guardian sets and only the owner clears.
2. Add a timelocked `NeuriioRegistry.release(token)` that frees a squatted X id / handle / wallet and marks the token as
   revoked for the app (it stays tradeable; nothing moves funds).
3. Bound the damage on-chain: e.g. at most N launches per hour per pad.
4. Off-chain: keep the key in a KMS/HSM, alert on signing volume, keep the 15-minute pass deadline.

### M-02 $NEURIIO can be farmed by self-dealing (accepted risk; partly fixed on 2026-10-23)

Severity: Medium, accepted by the user with the changes below. No user's principal is at risk; the harm is to the
$NEURIIO distribution: one actor can own most early $NEURIIO, and with it most of the $NEURIIO stakers' 50% of curve
fees and 40% of pool fees.

Where: `src/launch/NeuriioFees.sol` `_intake` (40% of a pool fee to the token's stakers) and
`src/stake/NeuriioMinter.sol:56-68` (`mintRate` $NEURIIO per $1 of that 40%).

Failure scenario: a whale graduates their own token, stakes it, and trades back and forth in its pool. Of each $1 of
fee, 40% comes back as the sole staker, 10% as the creator, 40% goes to $NEURIIO stakers (the treasury while nobody
stakes $NEURIIO; the whale once their own $NEURIIO is staked), 10% to the treasury.

Before the changes, USDC sent straight to NeuriioFees also counted as a fee (one transaction, no trading), and the
mint was 25 per $1 (10 $NEURIIO per $1 of fee): $10k then $1M bought ~10.1M $NEURIIO for ~$105k.

Changes made (user, 2026-10-23):
1. NeuriioFees credits only the fee the pad or pair reports (`notifyCurveFee(token, amount)`,
   `notifyPoolFee(token, amount)`; it reverts `FeeNotReceived` if that USDC isn't there). USDC sent any other way is
   nobody's fee, mints nothing, and anyone can `sweep()` it to the treasury. Test: `test_donationsMintNothingAndGoToTheTreasury`.
2. The deploy default mint rate is 10 per $1 (`script/NeuriioConfig.sol`; the code's cap stays 25): 4 $NEURIIO per $1
   of pool fee.

What remains (accepted): wash trading. Measured at the launch rate: a $50k round trip ($995 of fees) cost $483 and
minted 3,980 $NEURIIO; then ten $500k round trips ($99,500 of fees) cost $9,950 and minted 398,000 $NEURIIO, i.e.
~2.5 cents per $NEURIIO. Test: `test_washTradingCostPerNeuriio`. The user's plan: watch for it, keep $NEURIIO
transfers off, and review farming (sybil) wallets before transfers open or any airdrop. Note that the contracts
can't cut $NEURIIO already minted (NeuriioStaking has no owner), so any correction has to happen in a later
distribution (an airdrop or migration), not on the existing balances.

Further options if needed: a per-token daily mint cap (code), or a smaller `DECAY_SCALE` so the rate falls faster.

### L-01 A failing fee vault blocks curve sells and pool swaps, so "holders can always exit" depends on it

Severity: Low (needs a timelock action that is public for 48 h, or an action by the USDC issuer). The code and docs
promise that sells stay open even while paused; that holds only while the fee vault accepts fees.

Where: `src/launch/NeuriioPad.sol:465-469` (`_payFee`, called by `sell` at `:292`: a revert there reverts the sale),
`:395-399` (`setFeeVault` accepts any non-zero address); the fork's `UniswapV2Pair._takeFee` (out of scope) does the same
for every pool swap; NeuriioFees as a USDC recipient.

Failure scenarios:
- The timelock points the pad (and the factory) at a vault that reverts: malicious, or a mistake such as a NeuriioFees
  built on another registry, or an address without code. After the 48 h delay every curve buy and sell and every pool
  swap reverts; the curves' USDC and the graduated tokens are stuck until another 48 h change.
- The USDC issuer blacklists NeuriioFees: at once, with no delay, every curve trade (sells included) and every pool swap
  reverts, and creators' unclaimed fees in the vault are frozen. Recovery is the 48 h `setFeeVault` on the pad and the
  factory.

Reproduction: `test/audit/AuditOwn.t.sol` -> `test_revertingFeeVaultFreezesCurveSellsAndPoolSwaps` (mainnet config);
`AuditFiatUsdcTest` -> `test_blacklistedFeeVaultFreezesAllTrading` (a FiatToken-like USDC).

Suggested fix: make fee forwarding unable to block a trade: in `_payFee`, send the fee and notify with low-level calls
(or `try`), and on failure keep the fee in the pad (`pendingFees`, flushable to the vault by anyone later); do the same in
the pair's `_takeFee` (fork). In `setFeeVault`, require `code.length > 0`.

### L-02 A token flash swap skips its 1% pool fee by also taking 1 base unit of USDC out

Severity: Low. K still holds and no user's funds are at risk; the loss is the fee income (creators, stakers, treasury)
on token flash swaps, which are rare today (a graduated token trades only in its own pool). It breaks the stated rule
"token-side flash swaps still pay the fee".

Where: `src/swap/v2/UniswapV2Pair.sol:241-246`: `_sellFee` treats every swap with tokens in and any USDC out as a
sale; `:249-253`: `_checkK` then deducts nothing from the token input; `:265-267`: `_takeFee` charges only
`ceil(out / 99)`.

Failure scenario: a contract calls `pair.swap` directly to borrow B tokens **and 1 base unit of USDC**, and in the
callback returns the B tokens plus a top-up worth about 2 base units of USDC (`2 x R_t / R_q` tokens). The sale formula
applies: `(R_q - 2) x (R_t + top-up) >= R_q x R_t` passes, and the fee vault receives 1 base unit. The same loan without
the dust withdrawal must repay `B / 0.99` and pays about 1%. Measured on a freshly graduated pool: borrowing 103.45M
tokens (half the pool) owes $70.84 of fee; with the trick it pays $0.000001.

Reproduction: `test/audit/AuditPool.t.sol` -> `test_Audit_dustUsdcOutSkipsTheTokenFlashFee` (the intended path:
`test_Audit_tokenFlashPaysOnePercentWithoutTheDust`).

Suggested fix: use the sale formula only for a pure sale (no tokens leave the pool). Pass the token output into
`_feeAndK`, and when tokens also go out, deduct 1% of the token input in `_checkK` as well (or charge the larger of
the sale fee and the token-side fee).

### I-01 Curve fee split: the audit request and part of HANDOFF.md say 80/10/10, the code says 50/30/10/10

`src/launch/NeuriioFees.sol:32-38`: curve fees go 50% $NEURIIO stakers, 30% KNTQ buyback, 10% creator(s), 10% treasury.
The audit request (and HANDOFF.md's 2026-10-17 paragraph) describe curve fees as 80% stakers / 10% buyback / 10%
treasury with nothing to creators; HANDOFF.md's "Fee split (2026-10-20, final)" matches the code. Mainnet will run
exactly the audited code, so confirm 50/30/10/10 is intended (it can only change with a new NeuriioFees, and after
`lockVaults` a new one can't mint: I-02).

### I-02 After `lockVaults`, a replacement NeuriioFees can never mint $NEURIIO

`src/stake/NeuriioMinter.sol:83-94`: once vaults are locked, no address can be added. The pad's and the factory's
`setFeeVault` stay available, so the timelock can still move fees to a new NeuriioFees (a fix, a new split), but stakers
there earn USDC and no $NEURIIO, ever; removing the only vault (`setVault(v, false)`) ends minting for good. This is the
intended trade-off of the lock; it means NeuriioFees is effectively permanent for the mint. Test:
`test_afterLockVaultsAReplacementVaultNeverMints`. If a split change may be needed, decide before mainnet (e.g. a
one-time, timelocked vault migration in the minter instead of the full lock).

### I-03 Personal and FTF tickers are separate namespaces

`src/launch/NeuriioRegistry.sol:84-106`: a personal token's ticker (its handle in capitals) is checked only against
other handles; an FTF ticker only against other FTFs and the reserved list. An FTF can launch as `$ALICE` next to
`@alice`'s `$ALICE`. Test: `test_ftfTickerCanCopyAPersonalTicker`. Fix: check both namespaces in both register
functions (e.g. `tokenOfHandle` against the FTF ticker lower-cased, and `tokenOfFtfTicker` against the handle's ticker),
or have the backend refuse such tickers and the app show the kind of token clearly.

### I-04 `setReservedTickers` is case-sensitive

`src/launch/NeuriioRegistry.sol:141-145,165-168` hash the string as given, while tickers are compared in capitals, so
reserving "pump" blocks nothing. `DeployMainnet` passes `RESERVED_TICKERS` through as typed. Test:
`test_reservingALowerCaseTickerDoesNothing`. Fix: upper-case (or reject non-upper-case) input in `_setReserved`.

### I-05 Tiny buys pay no fee to the vault

`src/launch/NeuriioPad.sol:492,526-531`: the fee inside a gross curve buy is rounded down, so `quoteIn <= 100` (0.0001
USDC at 1%) pays 0. Not economical to exploit (gas costs far more than the 1% saved). Test: `test_tinyBuysPayNoFee`.
In the pool, a buy under 100 base units moves no fee to the vault either (`UniswapV2Pair.sol:265`), but its K check
still deducts the exact 1%, so that 1% stays in the pool instead.

### I-06 Anyone can restart a reward drip with 1 base unit

`src/stake/NeuriioStaking.sol:139-146,223-227`: `notifyReward` is open to anyone and every call re-spreads what's left
over a fresh hour. Pinged every minute, a reward that should be fully paid after an hour is ~64% paid; the rest keeps
dripping later to whoever stays staked. Nothing is lost, and NeuriioFees does the same on every fee, so in an active pool
rewards always pay out with an exponential tail. Test: `test_anyoneCanStretchADripWithOneBaseUnit`. Document it ("most
of a reward within an hour") or keep the old end time when the new amount is small.

### I-07 USDC issuer dependencies

If USDC is paused, every trade, claim and payout stops. Blacklisting a user only stops that address (they can move their
tokens and sell from another). Blacklisting `0x...dEaD` would make graduation's `skim(DEAD)` (a 0-USDC transfer) revert,
so no token on this pad could ever graduate (`DEAD` is a constant): test `test_blacklistedDeadBlocksEveryGraduation`.
Blacklisting NeuriioFees: L-01.

### I-08 `setFeeVault` accepts any non-zero address; `renounceOwnership` is available everywhere

`NeuriioPad.setFeeVault` (`:395-399`) only rejects zero: an address without code makes every fee-paying trade revert
(L-01). Every Ownable2Step contract keeps `renounceOwnership`: renouncing the pad would leave a paused pad paused forever
(the guardian could still pause later, nobody could unpause). Consider overriding `renounceOwnership` to revert.

### I-09 Stray funds

USDC or tokens sent by mistake to NeuriioPad, NeuriioRouter or NeuriioStaking are stuck (no sweep); USDC sent to
NeuriioFees is nobody's fee and can be swept to the treasury (M-02 change); tokens sent to a pool's address before graduation
are burned by `skim(DEAD)` (intended).

### I-10 Stale comments and names

`test/NeuriioStaking.t.sol:16` describes the curve split as 80/10/10; `test_xStakersMint100PerDollarEarned` checks 25 per
$1; HANDOFF.md line 16-18 still says 80/10/10 and "100 per $1". (`IFeeVault`, unused, was removed from
`src/swap/interfaces.sol` at the freeze.)

## 6. Assumptions about code outside the scope

1. Stock V2 parts of the fork: only a token's own pad can create its pair (`UniswapV2Factory.createPair`, `:38`), every
   pair is TOKEN/USDC, a fresh pair has zero reserves (so `skim` empties it), `mint(DEAD)` gives the LP tokens to
   `DEAD`, and the `lock` modifier holds for the whole `swap`. (The fee hand-off itself, `_takeFee` ->
   `notifyPoolFee`, is in scope and was checked: section 7.)
2. The factory's `quote` never changes after deployment, and its `feeVault` is either 0 or a NeuriioFees.
3. The pair never calls Neuriio contracts other than `notifyPoolFee`; a flash-swap callback runs before the fee.
4. USDC: 6 decimals, no transfer hooks, no fee-on-transfer, no rebasing, balances only fall by transfers the holder (or
   an approved spender) makes. Pause and blacklist are covered by L-01 and I-07.
5. The backend signs only verified identities with a short deadline (15 minutes today) and doesn't hand out two passes
   for one FTF ticker at once.

## 7. Checked and found fine

Curve and pad:
- `virtualQuote x virtualToken` never decreases (all rounding goes to the curve); `virtualQuote - realQuote` stays the
  launch reserve and `virtualToken - realToken` stays 279.9M, so selling everything back can never need more USDC than
  was raised (the `realQuote` cap in `_quoteSell` never binds in practice). Invariant-fuzzed.
- The pad is solvent across all curves at once (USDC >= sum of `realQuote`; tokens >= `LP_SUPPLY + realToken` each).
  Invariant-fuzzed, including "every holder sells everything back".
- The capped graduating buy never charges more than offered and `quoteToGraduate` always graduates.
- At every allowed setting (virtual reserve from 1 USDC to `uint96` max, fee 0 to 2%): no overflow, k never drops, the
  pad stays solvent, everyone can sell back, and graduation succeeds with the pool opening within 0.01% of the curve's
  final price (`testFuzz_Audit_curveAtAnySetting`, 1,024 runs).
- Graduation can't be blocked or front-run by outsiders: only the token's pad can create its pair; tokens or USDC sent
  to the predictable pair address are skimmed to `DEAD`; reserves stay far below `uint112`; the pool opens ~0.007%
  below the curve's final price.
- Buys, launches and graduations stop when paused; sells don't (subject to L-01).

Fees:
- `held` always equals creators' balances + treasury + buyback and never exceeds the vault's USDC; every fee's shares add
  up to the fee exactly (FTF remainder to the founder); shares nobody can take move down the line. Invariant-fuzzed.
- Staking or minter failures can't block trading (both are inside `try`), and a trader can't force them by choosing
  the gas limit: from the smallest limit at which a pool sell succeeds (248,393) to 300,000 above it, every successful
  sell paid both staker pools and the minter (`test_Audit_gasLimitCantSilenceStakingOrMinter`), because the work left
  after a catch needs far more than the 1/64 of gas a caller keeps.
- Only the token's own pad (`notifyCurveFee`) or pair (`notifyPoolFee`) can trigger an intake.

Staking and $NEURIIO:
- Solvent in USDC and in $NEURIIO (staked $NEURIIO plus every $NEURIIO reward owed, accrued or dripping); stakes add up
  to `totalStaked`; all rounding is down. Invariant-fuzzed with random stakes, claims, donations and time jumps.
- At the edges (stakes from 1 wei to 1B tokens, rewards up to 1B USDC): no overflow, and claims never add up to more
  than was paid in, losing at most a few base units to rounding (`testFuzz_Audit_stakingAtTheEdges`, 1,024 runs).
- A stake and unstake in the same second earns nothing; any reward drips for at least an hour after the last notify, so
  a just-in-time stake gets about 1/3,600 of the drip per second staked.
- Only NeuriioMinter can mint $NEURIIO, only from fees, never past 1B; the locks hold even for the timelock; $NEURIIO
  can't move between holders while transfers are off; NeuriioStaking's built-in allowance is only ever used to pull from
  the caller.

Pool fee code (`UniswapV2Pair.sol`, Neuriio parts):
- K after fees never drops: 1,024 accepted random direct swaps of every shape (USDC and/or tokens out, USDC and/or
  tokens paid back in the flash-swap callback), plus the per-path argument in the code's comments.
- The fee sent to NeuriioFees equals the intended formula on every one of those swaps.
- A sale pays at least 1% of what the seller gets plus the fee (`ceil(out / 99)`); a buy's K check charges the exact
  1% and the vault gets its floor; a swap with USDC both in and out pays on both legs, which only the trader can
  choose.
- No overflow: balances fit `uint112`, so SafeMath's products stay below `2^256`; the raw `/` divides by constants or
  by the pool's token balance, which a swap can't empty.
- A flash-swap callback (which runs before the fee) can't re-enter the pair or report a fee itself; a curve trade and
  staking the borrowed tokens inside it settle normally, and the pool still takes its 1%
  (`test_Audit_flashSwapCallbackCantBreakAnything`).
- `_takeFee`'s calls: re-entering the pair is blocked by `lock`; a reverting vault reverts the swap (L-01) but never
  skips the fee; reserves are set from the post-fee balances; with no vault set the fee stays in the pool.
- Balances above the reserves (donations) count as input and pay 1%; `skim` and `sync` behave as in V2; swap fees
  leave the pool, so liquidity added later and V2's `feeTo` share see only rounding dust.

Router:
- Never keeps funds (refunds the unused part of a graduating buy); its standing approvals to pads are only used inside
  trades it starts; pool buy and sell math pass the pair's K check (sell: `floor(0.99 g) + ceil(floor(0.99 g) / 99) <= g`).

Signatures and access control:
- `hashLaunchPass` and `hashFtfPass` equal the standard EIP-712 digests a wallet or viem signs (fixed arrays included),
  checked against an independent encoder; high-s, flipped-v and 64-byte signatures are refused; a pass only works on
  its pad, its chain and with the current signer (rotation voids every outstanding pass); each identity launches once.
- Under the mainnet configuration the deployer keeps nothing, the Safe can only pause at once, and every other change
  waits 48 h in public (existing `test/DeployMainnet.t.sol`).
- The deploy script broadcasts many separate transactions, but every call before the handover is owner-only (the
  deployer), and what an outsider can do meanwhile is harmless: launching needs a pass from the new signer, and
  `notifyReward` only accepts gifts to pools that exist.
- Reentrancy: every user entry point that moves funds is guarded; external calls go only to known contracts; the
  launched tokens and $NEURIIO have no hooks.

## 8. Dropped candidates

None: every candidate the lead review raised reproduced, or was checked and is listed in section 7.

## 9. Tests added (`test/audit/`)

| File | What it shows |
|---|---|
| `AuditOwn.t.sol` | M-01, M-02 (donations ignored; wash-trading cost), L-01, I-02 to I-07 on the mainnet configuration (`AuditMainnetBase`) and on a FiatToken-like USDC (`AuditFiatUsdcTest`) |
| `AuditInvariants.t.sol` | handler-based invariants (256 runs x 100 calls): pad solvency, curve reserves and k, fees held and conserved, staking solvency in USDC and $NEURIIO, no unexpected reverts; plus a fixed walk that reaches every state |
| `AuditSignatures.t.sol` | EIP-712 digests vs an independent encoder, malleability, pad/chain/signer binding, FTF ticker race |
| `AuditPool.t.sol` | L-02; the token flash swap's intended 1%; fuzz of random direct pair swaps of every shape (K never drops, fee = formula) |
| `AuditAttacks.t.sol` | the gas-limit sweep against NeuriioFees' try/catch; a flash-swap callback that tries to re-enter or interfere |
| `AuditExtremes.t.sol` | fuzz of the curve at every allowed reserve and fee (through graduation or a full sell-back); staking at the edges |
