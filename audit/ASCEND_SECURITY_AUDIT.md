# Neuriio on Ascend: internal security audit

Date: 2026-11-01. Internal audit before the code freeze for Cantina / Spearbit. Companion: `audit/ASCEND_ARCHITECTURE.md`.

This is an internal review, not a replacement for the outside audit. It was written by the AI model that wrote the contracts, so the
same blind spots may apply to both. Slither and Aderyn weren't run (they aren't installed, and installing packages was ruled out for
supply-chain reasons); the outside firm should run them.

## 1. Scope

| File | nSLOC |
|---|---:|
| `src/launch/NeuriioLauncher.sol` | 378 |
| `src/launch/IAscendAdapter.sol` | 10 |
| `src/stake/NeuriioTokenStaking.sol` | 134 |
| **Total** | **522** |

Compared with the last freeze (`audit-freeze-2026-10-23`): 1,243 nSLOC across 8 contracts, plus about 80 of pool fee code.

Code version: frozen in the commit tagged `audit-freeze-ascend-2026-11-01`.

`script/DeployAscend.s.sol` was read as the mainnet configuration, and access-control findings are judged against it.

Out of scope: the real adapter (not written; Ascend hasn't shared its contracts), Ascend's own contracts, the fee router
(`keeper/`), the backend, and the older contracts still in the repo. Where safety rests on them, the assumption is stated in the
architecture document.

## 2. Method

1. Every in-scope line read, and each of Cantina's ten risk areas from their 2026-10-26 scope document for the old stack, mapped to the new
   code (section 3).
2. Tests written for each area in `test/audit-ascend/` and `test/DeployAscend.t.sol`: unit, fuzz against independent versions of the
   rules, EIP-712 against Foundry's independent encoder, and handler-based invariant campaigns that keep their own books.
3. The deploy script run for real against a local chain with `forge script`.
4. A mutation check, to test the tests: 83 deliberate one-line breaks to the three contracts and the deploy script (a removed check, a
   missing `onlyOwner` or `nonReentrant`, an off-by-one deadline, a dropped settle, a deployer left with power), each run against the test
   suite. All 83 were caught. An earlier pass on the same approach found one gap (nothing tested that a pass's `founder` must be the
   sender), now covered. Invariant campaigns ran shorter during this check, for speed.

## 3. Cantina's risk areas

| # | Their area | Status now | Result | Tests |
|---|---|---|---|---|
| 1 | Graduation atomicity | No graduation. The equivalent: launch + first buy in one transaction | Whole or not at all. A failed launch, failed buy, or missed minimum leaves no trace and the pass stays usable. No reentry on any path | `AuditLauncherAdapter` |
| 2 | EIP-712 and signer trust | Same design | Digests match the independent encoder. No replay, cross-chain, cross-contract, or personal/FTF cross-use. No malleable or compact signatures. Deadlines hold to the second on both paths. Every field is signed. A leaked signer: see M-01 | `AuditLauncherSignatures` |
| 3 | Identity uniqueness | In the launcher now | No collisions across X ID, wallet, handle or ticker. Handle and ticker rules match independent versions on generated input. Reserved tickers blocked in every casing and checked first | `AuditLauncherIdentity` |
| 4 | Pool sell fee | Gone: Ascend's | Not applicable | |
| 5 | Staking drip accounting | Single USDC stream | Exact shares, settle before every change, never overpays, only dust lost (at most 3 base units per reward in the fuzz test), nothing locked when everyone leaves. Invariants hold under random action | `AuditStakingAccounting`, `AuditInvariants` |
| 6 | $NEURIIO cap and transfer lock | Gone: no token | Not applicable | |
| 7 | Curve and pool routing | Gone. The equivalent: first-buy slippage and refunds | Minimum enforced, zero tokens refused, unused USDC returned, adapter can't keep USDC | `AuditLauncherAdapter` |
| 8 | Upgradeability and governance | Replaceable adapter behind a timelock | Deployer never holds power (its ownership event goes straight to the timelock). Guardian can only pause. Owner changes wait 48 h. Removing an adapter only stops new launches. See I-02, I-04 | `DeployAscend` |
| 9 | Pause mechanics | Launches only | Pause stops launches and nothing else. Staking has no pause, and only the owner can unpause | `DeployAscend` |
| 10 | FTF structure | Same rules | Exactly 4 distinct members, founder first and sender, ticker rules and uniqueness. Member wallets reach the adapter | `AuditLauncherIdentity` |

Correction to their document: it says the signer has no on-chain rotation. `setLaunchSigner` exists, behind the timelock.

## 4. Fixed during this audit

| ID | Issue | Fix |
|---|---|---|
| F-01 | Ownership would have passed through the deployer, and setting the guardian needed a post-deploy step | Owner and guardian are constructor arguments; the deployer never holds power |
| F-02 | An adapter could keep a buyer's unused USDC | The launch reverts if the adapter ends up holding more USDC than before (`AdapterKeptUsdc`) |
| F-03 | An adapter could return USDC, or an address with no code, as a launched token, which would then be stakeable | Refused with `BadAdapterToken` |
| F-04 | If Ascend's launch needs extra parameters, the audited launcher would have had to change | `launchData`, signed into the pass and handed to the adapter |
| F-05 | The launcher had no deploy path to judge governance against | `script/DeployAscend.s.sol`, with `check()` reading it all back on-chain |

## 5. Open findings

No critical or high findings. Each finding below has a test showing it (`test_M01_...`, `test_L01_...` and so on).

### M-01: a leaked launch signer can take identities for good (acknowledged, carried over)

**Where:** `NeuriioLauncher._checkPass`, `_checkFtfPass`.

**Impact:** whoever holds the signer key can sign a pass for any X account, launch under its handle, and that account can never launch.
Nothing on-chain can undo it. No funds are at risk: passes move no money.

**Mitigations in place:** the guardian can pause at once. Rotating the key takes the 48-hour timelock, with launches paused meanwhile.

**Recommendation:** keep the key in the backend's secret store only, and alert on any `Launched` event the backend didn't issue a pass for.
The owner could be given a way to clear a squatted identity, but that adds power over identities, so it's left out.

### L-01: whoever stakes first takes what's being held, and a dust stake counts as a staker

**Where:** `NeuriioTokenStaking._update`, `notifyReward`.

**Impact:** a reward paid into a pool with nobody staked goes entirely to the first staker, even 1 wei. The fee router avoids this by sending that
token's 40% to treasury, but only if `totalStaked` is 0. Someone could stake dust in every token with no real stakers and collect the
stakers' share until someone else joins. They'd be the only staker, so this isn't theft from anyone staked, but it takes money that was meant for
treasury.

**Recommendation:** have the router treat a pool under a minimum total stake as having no stakers. It's an off-chain setting, so it doesn't
affect this freeze.

### L-02: dust rewards can slow a drip

**Where:** `NeuriioTokenStaking.notifyReward`.

**Impact:** anyone can pay 1 base unit, and each call spreads what's left over a fresh hour. Done non-stop, about 63% has paid out after the
first hour instead of 100%. Nothing is lost, the griefer gains nothing, and the rest finishes within an hour of them stopping.

**Status:** accepted. Limiting the caller would need an owner or a fixed key, which staking deliberately doesn't have. The outside firm may
have a better idea.

### I-01: rounding dust stays in the contract

Rounding always favours the contract. $10 over 100M staked, updated every minute, loses under 60 base units ($0.00006). With no owner, it stays there.

### I-02: a hostile adapter can take first-buy USDC

The launcher can't tell a real Ascend token from a fake one. A hostile adapter could mint worthless tokens and keep the USDC of whoever launches while
it's plugged in, up to what each chose to spend. It can't touch anything else: not other people's approvals, not the rest of the buyer's balance, not
staking. Replacing the adapter takes the 48-hour public timelock, and the Safe can cancel. **The real adapter needs the same scrutiny as these contracts.**

### I-03: anything sent straight to staking is stuck

USDC or tokens transferred directly aren't counted for anyone, change nothing, and can't be rescued, because there's no owner.

### I-04: the owner can renounce

Inherited from `Ownable`. It would take the Safe and the full delay, and would freeze the launcher's settings for good (a pause could never be lifted).
Staking and launched tokens carry on.

### I-05: staking assumes launched tokens don't rebase

Fee-on-transfer tokens are counted correctly on the way in. A rebasing token would break its own pool's accounting, but no other pool's. To be confirmed
with Ascend.

## 6. Test results

All pass. Fuzz tests run 1,024 times each.

| Suite | Tests |
|---|---:|
| `test/audit-ascend/AuditLauncherSignatures.t.sol` | 10 |
| `test/audit-ascend/AuditLauncherIdentity.t.sol` | 11 |
| `test/audit-ascend/AuditLauncherAdapter.t.sol` | 16 |
| `test/audit-ascend/AuditStakingAccounting.t.sol` | 20 |
| `test/audit-ascend/AuditInvariants.t.sol` (staking: 4 invariants, 256 runs of 100 calls; launcher: 2, 128 runs of 40 calls) | 6 |
| `test/DeployAscend.t.sol` | 15 |
| `test/NeuriioLauncher.t.sol` | 57 |
| `test/NeuriioTokenStaking.t.sol` | 27 |
| **Total for this scope** | **162** |

Not done: formal verification, Echidna or Medusa, Slither or Aderyn, or a fork test against Ascend (its contracts aren't available). Everything
that touches Ascend here runs against a mock adapter, so **this audit says nothing about how the launcher behaves with Ascend's real contracts.**
