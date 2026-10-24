# Handoff — Neuriio (state as of 2026-10-22: USDC world LIVE on app.neuriio.xyz (testnet); NEXT CHAT: mainnet readiness: Safe rehearsal DONE; next the internal audit, then the audit freeze, see "NEXT SESSION")

**Trade Arena (2026-10-24; escrow `src/arena/NeuriioArena.sol` + 31 tests written, not deployed):** 1v1 paper-perps duels for HYPE wagers behind the greyed "Trade" button;
plan, decided rules and open questions in `TRADE_ARENA.md`.

Read this first in a new session. `README.md` has per-step detail; this file is the current truth.
**Consolidated 2026-10-12:** finished work, old session logs, the paused PropAMM stack, superseded deployments and the
dropped Higgsfield prompts were removed from this file. The full previous version is in git:
`git show a73300e:HANDOFF.md` (everything up to 2026-10-10, incl. PropAMM/one-click design, old testnet addresses,
security sweeps #1-4 in detail, the Uniswap V4 research and Appendix B/C video prompts).

**Project name: Neuriio.** Local folder `/Users/von/Neuriio`; code in the **private** GitHub repo
**https://github.com/Neuriio/Neuriio** (branch `main`). Vercel deploys the app on every push to `main`; the EC2
watcher + payout bot update with `/usr/local/bin/neuriio-update` (run via SSM). Railway is no longer used.

## USDC WORLD (live since 2026-10-18): contracts, backend (switch run), app (pushed 4701f76) and docs (88206f4)

Final design (user, 2026-10-17 evening; memory "loss-mint-staking-plan"): tokens pair with USDC; every trade pays 1%
(curve and pool, bots included: the fee is inside the new pools). Curve fees (final 2026-10-20, see "Fee split"):
50% $NEURIIO stakers / 30% KNTQ buyback / 10% creators / 10% treasury. Pool fees: 40% $NEURIIO stakers / 40% that
token's stakers / 10% creator / 10% treasury. Staking an X token (opens at graduation) earns its USDC fees AND mints
$NEURIIO: 25 per $1 earned (set 2026-10-20, see "Neuriio cap"; 1B hard cap), flat until $1M of total platform fees,
then PAPER's decay (S = $120M). Staking $NEURIIO earns USDC only. Claimed $NEURIIO is staked automatically;
$NEURIIO can't be transferred. No loss-mint, boosts or locks. Contracts: `src/stake/` (NeuriioStaking,
NeuriioMinter, NeuriioPlatformToken), `src/launch/NeuriioFees.sol` + `NeuriioPad.sol`, `src/swap/NeuriioRouter.sol`,
`src/swap/v2` (USDC quote + 1% fee), `src/testnet/TestUSDC.sol`. 88 Foundry tests (+1 fork test).

### NEXT SESSION: MAINNET READINESS (user, 2026-10-22: get ready for mainnet now; the RPC switch is left for last)
Goal (user): audit-ready as if mainnet were tomorrow, so launch = run ONE script with the audited code. Mainnet is a
FRESH deploy (nothing moves from testnet: tokens, balances, addresses all start new; the app/Supabase/bots switch config).
DONE IN CODE 2026-10-22 (not deployed: testnet keeps its contracts; NOT committed yet). 88 tests pass, fmt clean,
NeuriioPad 19,862 B (4,714 B under EIP-170):
- `NeuriioMinter.lockVaults()`: no new minting vault ever (removing one stays possible: off-switch).
- Pool sells pay a true 1% of the sale in USDC (pair `_feeAndK`/`_sellFee`/`_checkK`/`_takeFee` on a memory `Flow`
  struct against stack-too-deep; router `getSellAmountOut` = 99% of V2's no-fee output for `sell` + `quoteSell`; buys
  and token flash swaps unchanged). Breaks V2-adapter math for SELLS only (interfaces.sol notes it).
- Ownership model (user, 2026-10-22): TIMELOCK + EMERGENCY PAUSE. `NeuriioPad.guardian` (+ `setGuardian`, owner only):
  owner or guardian can `pause()` at once; only the owner unpauses; the guardian has no other power.
- `script/DeployMainnet.s.sol`: the whole mainnet stack in ONE run on the real USDC (no TestUSDC/faucet): deploy + wire,
  wallets, guardian = Safe, extra reserved tickers, locks (`lockVaults`, `freezeMintCurve`, `lockMinter`), then a
  TimelockController (0 delay + deployer as proposer/executor for one batch that accepts every ownership, gives the Safe
  proposer/canceller/executor, revokes the deployer, sets the real delay); factory feeToSetter -> timelock. Ends with
  `check()` reverting on anything off; the deployer keeps NO power. Refuses: testnet chain (unless ALLOW_TESTNET),
  non-6-decimal USDC, SAFE without code, the testnet launch signer, TIMELOCK_DELAY < 1 day.
- `test/DeployMainnet.t.sol` (7 tests) runs that script locally: owners/locks/roles, deployer powerless, Safe pauses
  at once but unpause/admin changes wait the delay (early = revert), locks hold even for the timelock, launch ->
  graduation -> pool sell (1% of the sale) -> payProtocol, bad settings refused. (Local chain quirk: warp first, the
  timelock marks done ops with timestamp 1.) Also new: guardian test, lock tests, sell-fee tests (exact, big-sell,
  direct-pair, flash swap, fuzz checks every fee). Stale fee-split comments in NeuriioPad/NeuriioStaking fixed.
INTERNAL AUDIT (2026-10-23, done): `audit/SECURITY_AUDIT.md` + `audit/ARCHITECTURE.md`, tests in `test/audit/` (118
tests pass). No Critical/High. Open: M-01 leaked launch-signer key (permanent identity squatting; only fast stop is
pause), L-01 failing fee vault blocks sells, L-02 pool token flash swap dodges the fee, Info items (confirm the curve
split 50/30/10/10 vs the 80/10/10 in the audit request). The separate review passes were stopped (cost; overkill).
$NEURIIO FARMING (M-02; user, 2026-10-23): a whale can farm $NEURIIO by wash trading their own graduated token's pool
(creator + sole staker + $NEURIIO staker get ~90% of the fees back). DONE IN CODE (not deployed, not committed):
(1) NeuriioFees credits only the fee the pad/pair reports (`notifyCurveFee(token, amount)` /
`notifyPoolFee(token, amount)`; pad + pair updated), so USDC sent straight to the vault mints nothing; anyone can
`sweep()` it to the treasury; (2) deploy default MINT_RATE = 10 per $1 (`script/NeuriioConfig.sol`; code cap stays
25). No daily mint cap for now. What's left costs ~2.5 cents per $NEURIIO by wash trading (test
`test_washTradingCostPerNeuriio`). PLAN (user): watch for it rather than block it (the treasury earns 10% of every
farmed fee, and $NEURIIO can't be traded while transfers are off); before enabling transfers or any airdrop, audit
for sybil farming and cut those wallets' share. CAUTION: the contracts can't cut $NEURIIO already minted
(NeuriioStaking has no owner), so the cut must happen in that later distribution, not on existing balances. These
changes break compatibility with the live testnet contracts (old notify signature): any future testnet deploy must
be the whole stack.
SAFE (2026-10-22): Safe's canonical v1.3.0 contracts APPEARED on Elysium testnet today (23:16 UTC, deployed by
0x3e79…736B via the CREATE2 deployer), byte-identical to Ethereum mainnet's; no Safe UI/tx service for Elysium. User
chose a 2-OF-3 Safe (public addresses only; hardware wallets on separate devices; not Privy wallets). Tooling: `script/CreateSafe.s.sol` (checks Safe's code hashes first, creates the Safe
from OWNERS/THRESHOLD/SALT_NONCE, reads it back), `script/SafeTx.s.sol` (`hash()` -> each signer sends
`approveHash(hash)` from their own wallet, e.g. `cast send <SAFE> "approveHash(bytes32)" <hash> --ledger`; `exec()`
checks the approvals and executes; anyone can send it). `test/fork/Rehearsal.t.sol` (FORK=true forge test --match-path
test/fork/Rehearsal.t.sol) PASSES on a fork of testnet with the real Safe: create 2-of-3 -> DeployMainnet -> pause
with 2 approvals -> unpause via the timelock (refused early, executed after the delay). DeployMainnet allows a delay
down to 5 minutes ONLY on the testnet chain (rehearsals); mainnet needs at least 1 day. No other protocol on Elysium
testnet uses a multisig/timelock (1,200 verified contracts checked; single EOAs own them; only the chain's bridge sits
behind Arbitrum's UpgradeExecutor). On mainnet the same Safe address can be recreated (same owners, threshold, salt)
once Safe's contracts are there (anyone can replay them via the CREATE2 deployer if needed).
LIVE REHEARSAL ON TESTNET (2026-10-22): the Neuriio Safe `0x68Ed49C77dF7fB4928510d5Ac65C6074674D264E` (2 of 3; owners
0x15f2…C577, 0x90F7…bea7, 0xaC0D…c2e7; salt nonce 0) exists; each signer got 0.01 testnet HYPE from the burner;
DeployMainnet ran with ALLOW_TESTNET=true, TIMELOCK_DELAY=600 and a throwaway launch signer: a SEPARATE stack (the
live app's contracts are untouched), addresses in `deployments/elysium-testnet-rehearsal.json` (timelock
`0x6348…d8ed`, pad `0xf9e4…e2a0`). Every check passed on-chain: the timelock owns registry/pad/fees/minter/NEURIIO
and is the factory's feeToSetter, guardian = Safe, the Safe holds proposer/canceller/executor, the deployer holds no
role, all locks on, treasury + buyback = the Safe. Signing page `/safe` (unlisted; `app/src/components/SafePage.tsx` +
`app/src/lib/safe.ts`; LOCAL ONLY so far, signers on other devices need it pushed): an owner opens an approval link
`/safe?to=<contract>&data=<calldata>&nonce=<Safe nonce>&note=<text>`, connects Rabby/MetaMask (adds Elysium if
missing), approves (`approveHash`), and anyone executes once 2 have approved (the last owner can "Approve & execute").
It decodes the call into words (timelock schedule/execute included), lets owners approve ahead of the Safe's nonce,
and shows when a timelocked action can run. PRACTICE RUN DONE (2026-10-23 UTC, the 3 signers via /safe from the
user's Mac): pause executed 01:05:57; unpause scheduled 01:06:31; all 3 owners approved the execute early, the timelock
held it until 01:16:31, executed 01:16:55 by 0x90F7…bea7 (tx 0xcb59ad69…). Checked on-chain: Safe nonce 3, every Safe
execution succeeded, pad paused -> unpaused, the timelock operation marked done. The links were: (1) pause: to = pad, data
`0x8456cb59`, nonce 0; (2) schedule the unpause: to = timelock, `schedule(pad, 0, 0x3f4ba83a, 0x0, salt, 600)`,
nonce 1; (3) after 10 minutes, run it: to = timelock, `execute(pad, 0, 0x3f4ba83a, 0x0, salt)`, nonce 2; salt =
`cast keccak "neuriio rehearsal unpause 1"`, calldata via `cast calldata`.
Deploy-day inputs (env of DeployMainnet): USDC (Elysium mainnet), SAFE (deployed, signers 2-of-3 or 3-of-5 on
separate devices), TREASURY_WALLET + BUYBACK_WALLET (suggest the Safe), LAUNCH_SIGNER (NEW key; its private key goes
into Supabase `LAUNCH_SIGNER_KEY` for the mainnet functions), VIRTUAL_QUOTE (testnet 6,000e6), TIMELOCK_DELAY (172800 =
48 h), optional RESERVED_TICKERS. From Elysium: chain ID, USDC address, Safe's canonical contracts on mainnet (on
testnet since 2026-10-22; check with `cast code`), explorer for verification.
Next, in order: (1) commit; (2) internal deep audit of the 8 Neuriio contracts + the pool's Neuriio fee code (see
below) (RUNNING since 2026-10-23 in its own
session "Deep audit of the Neuriio contracts": Fable review passes, every finding proven by a test in `test/audit/`,
report in `audit/SECURITY_AUDIT.md` + `audit/ARCHITECTURE.md`, no code changed), then fix what the user picks, so the
outside firm gets a commit hash that already has our own fixes; (3) freeze (user, 2026-10-23): ONE commit hash for the
outside firm, scope = the 8 Neuriio contracts (NeuriioPad, NeuriioFees, NeuriioRegistry, NeuriioToken, NeuriioStaking,
NeuriioMinter, NeuriioPlatformToken, NeuriioRouter) + the pool's Neuriio fee code; the hash comes from a separate private audit repo holding ONLY
contracts + tests + scripts + foundry config (this repo also holds the app, Supabase code and this file); verify the
firm first (they reached out unprompted). The pool's Neuriio fee code (user, 2026-10-23: in BOTH audits): the pool
contract `src/swap/v2/UniswapV2Pair.sol` is no longer stock Uniswap: ~70 lines are ours (the 1% fee + this week's
sell-fee fix: `_feeAndK`, `_sellFee`, `_checkK`, `_takeFee`, called from `swap()`), the K check that guards every
graduated pool's liquidity; the rest of the fork is stock Uniswap V2 and stays out of scope. Then the professional
audit; (4) off-chain mainnet switch prepared behind config (app chain/RPC/addresses, Supabase WORLDS +
indexer start block, watcher DEPLOYMENTS, Privy chain, no faucet/testnet labels, HL_TESTNET=false); (5) deploy day: run
DeployMainnet, verify sources, switch config, then the RPC switch (QuickNode for servers). Optional: record pool sell
volume as the gross sale (out + fee) so fee/volume reads 1.000% for sells too.
Also open: the big team's question; answer with the proof page (Phase 5 below) and the token page URL
(they asked for our Elysium-mainnet token page URL, so they will check who controls the contracts): `https://app.neuriio.xyz/explore?t=<token address>` (a
cleaner `/token/<address>` route with the old link redirecting is optional; mainnet domain not decided).
Not pushed yet (2026-10-22): the CI formatting fix in `test/NeuriioPad.t.sol` (CI's `forge fmt --check` fails until
it's pushed). Careful: `forge fmt` itself BREAKS that file (it moves the `// their curve-fee shares` comment into the
for-loop header, commenting half of it out); the fix there is hand-written.
Licensing: every contract file already says `SPDX-License-Identifier: MIT` (user is happy with that, no LICENSE file
added); `src/swap/v2` is the Uniswap V2 fork and stays GPL-3.0 (its LICENSE is in that folder). Repo stays private.

### Done 2026-10-21/22 (reference)
- **Railway exit.** Website on **Vercel** (project root `app`, `app/vercel.json`; vars
   `VITE_ELYSIUM_RPC` + `VITE_PRIVY_APP_ID` as Config; Privy allowed origin `https://neuriio.vercel.app` added;
   Cloudflare `app` CNAME -> Vercel, DNS only). Live updates restored: app realtime uses the publishable key
   (942d561). Watcher on **AWS EC2** `i-03b1a86c4d1fff123` (us-west-2, t4g.micro, AL2023, account 137098073913):
   no inbound ports, managed via SSM Session Manager only, IMDSv2, encrypted disk; systemd `neuriio-watcher`
   (auto-restart) runs `/usr/local/bin/neuriio-watcher`, which reads SSM SecureStrings
   `/neuriio/watcher/supabase-secret-key` + `/neuriio/watcher/rpc-url` (keyed Conduit URL: keyless public RPC
   rate-limits it) into memory; IAM role `neuriio-watcher-ec2` (SSM core + GetParameter on /neuriio/watcher/* and /neuriio/payout/*);
   SG `sg-0b87459f1442f8868`. Code: sparse clone of keeper+deployments via read-only GitHub deploy key
   `neuriio-watcher-ec2`; update = run `/usr/local/bin/neuriio-update` via SSM (git pull, npm ci
   --ignore-scripts, restart). Logs: `journalctl -u neuriio-watcher`. hypedexer RPC is DEAD (stuck at block
   10,340,873): removed from watcher + payout defaults (12dd4aa); watcher polls (no WS_URL).
- **Payout bot on EC2** (same box): systemd `neuriio-payout`, hourly `payProtocol()` on every fee vault, gas paid
   by a gas-only wallet `0x2e5A15fe4587aF7E6ec49869eAd906F93BCCd225` (key in SSM `/neuriio/payout/gas-key`, ~0.02
   HYPE covers thousands of runs). Paid ~$8,323 (2026-10-21) + $3,590 (2026-10-22) to `0x10E9…EEC3`. The owner key
   `0xeF58…` no longer runs anywhere. KNTQ buy + burn of the buyback share is still manual.
- **Optimization done:** "trades:all" batched into one message per second (charts stay per trade, fb3e191); tabs
   hidden for 60 s close their live connections and catch up when shown; indexer checks Hyperliquid every 10 min with
   one cursor query (runs ~24 s -> ~5 s; it was ~60% of all Supabase requests, 74dce9e). The rest of the scaling plan
   is "later, when growth needs it" (section below), not a priority.
- Small leftovers, any time: delete Cloudflare `_railway-verify` TXT and the Railway project; user signs in to AWS
   as ROOT -> create an admin IAM user with MFA; rotate the Conduit key (it's public in the browser anyway).
- **Security review 2026-10-22 (done, committed):** no critical/high; every live attack blocked. Fixed + deployed:
   indexer never returns error text (viem errors carry the RPC URL + key); posts/ftf action lookups use
   Object.hasOwn (`"toString"` skipped the post limit); write actions rate-limited in the DB
   (`hit_rate_limit`, `_shared/rateLimit.ts`, migration 20261022043242); anon/authenticated lost every non-SELECT
   privilege (20261022043307, incl. default privileges). Open lows: faucet sybil (many X accounts), FTF pfp bytes not
   checked + no upload cap, no full CSP on the site, functions can be spammed to burn the invocation quota,
   leaderboard is a security-definer view (by design), pg_net in public schema. Local migration files now match
   the remote history exactly (posts files renamed to 20261020195551/200400; same SQL, comments only differed).

### Multisig + locks roadmap (written 2026-10-21; SUPERSEDED by "NEXT SESSION" above, kept for reference)
One wallet, `0xeF58…17a8`, owns everything today (Pad, Registry, Fees vaults x4, NEURIIO, Minter, TestUSDC,
swap factory `feeToSetter`). All Ownable contracts are `Ownable2Step` -> NO redeploy except the Minter fix.
Tokens, staking and router have no owner. On-chain today: `minterLocked=false`, `mintCurveFrozen=false`.
Risks a partner would flag: Minter `setVault` has NO lock (any approved address can mint NEURIIO up to max supply);
Pad `setFeeVault` + factory `setFeeVault` can send curve/pool fees anywhere (no lock possible: multisig + timelock).
Fee is capped at 2% in code (`MAX_FEE_BPS`); `pause` keeps sells open.
- **Phase 1: Safe on Elysium (BLOCKER).** No Safe contracts on chain 99801 (checked v1.3.0 + v1.4.1 canonical addresses;
  singleton factory `0x914d…43d7` absent; CREATE2 deployer `0x4e59…956C` IS there). app.safe.global doesn't list
  Elysium. Ask Safe to deploy their singleton factory (canonical addresses) or deploy Safe ourselves; sign via
  safe-cli or a self-hosted Safe UI. Signers: normal wallets (Rabby / hardware) with Elysium added, NOT Privy
  embedded wallets. 2-of-3 or 3-of-5, separate devices; test with a small transfer.
- **Phase 2: Minter fix (the only contract change).** Add `lockVaults()` (same pattern as `freezeMintCurve`), tests,
  review; redeploy the Minter only, `setMinter` on NEURIIO, add the 4 fee vaults, lock. No-code alternative:
  `renounceOwnership()` on the Minter once vaults are final (a future fee vault could then never mint).
- **Phase 3: timelock.** OpenZeppelin `TimelockController` (~48h), Safe = only proposer. Owns Pad/factory fee
  routing so changes are public 48h ahead. Safe keeps direct control of emergency actions only (`pause`, launch signer).
- **Phase 4: hand over + lock.** `freezeMintCurve()`, `lockMinter()`, `lockVaults()`; `transferOwnership` -> Safe or
  timelock on Pad, Registry, Fees x4, NEURIIO, then Safe `acceptOwnership()` on each; factory `setFeeToSetter` ->
  timelock (ONE step, triple-check the address). Also check the old fee vaults / old HYPE-world launchpads and who
  receives the pools' `feeTo` share, so nothing is missed.
- **Phase 5: prove it.** Public page: each contract, its owner (Safe/timelock), what's locked, tx links. Send it to
  the team with the URL answer. Mainnet repeats this setup before any public launch.
The owner key no longer runs in any bot (the payout bot moved to EC2 with its own gas-only wallet, see "Done").
Phase 1 check first: Safe was still absent on Elysium 2026-10-21; re-check `cast code` at the canonical Safe
addresses before choosing between asking Safe and deploying it ourselves.

### Later, when growth needs it: scaling plan (NOT a priority; the cheap parts were done 2026-10-22, see "Done")
Done + live today: FTF accept fix (setMember updated the row instead of upserting: role NOT NULL), Feed with real
posts / likes / comments (tables posts, post_likes, post_comments, view posts_feed; `posts` Edge Function, Privy
login, 5 posts / 10 comments / 60 likes a minute), sample posts gone. Railway paused deploys platform-wide for a while
(07263d0 was an empty commit to re-trigger it).
Capacity now: a few hundred online at once is comfortable, ~1-2k at once is where limits bite. The first wall is
Supabase's monthly function-call quota (the notifications inbox poll = an `ftf` call every 20 s per logged-in user,
and each call also does a Privy user lookup). Chain calls already go browser -> RPC directly (never via our server);
only the shared Conduit key is the shared limit. Charts come from Supabase + realtime, not the RPC.
To stay on free tiers, in this order (none touch the contracts):
1. Explore / trending / token pages read market data (prices, mcap, curve progress) from the indexer's Supabase
   tables, not the chain. Only personal reads (balances, stakes, a quote at buy time, sending) stay on RPC.
2. viem `fallback` transport: public Elysium RPC first, the Conduit key as backup.
3. Read chain state on change, not on a timer: after your own tx, when a box opens, per block while the tab is
   visible; pause all polling in hidden tabs.
4. Notifications: realtime instead of the 20 s poll, and verify the Privy JWT once + cache who the user is (no
   Privy API lookup per call).
5. Feed: realtime for new posts / likes / comments instead of the 15 s poll.
Done 2026-10-22: "trades:all" batched into one message per second (charts stay per trade); tabs hidden for 60 s close
their live connections and catch up when shown; indexer checks Hyperliquid every 10 min with one cursor query (runs
~24 s -> ~5 s; it was ~60% of all Supabase requests). Old tabs keep old code until reloaded (a pre-fix tab on the
vercel.app URL showed 10-12 s chart lag): consider a version check that reloads idle tabs after a deploy.
Added 2026-10-22 (Supabase stays the indexer; no new vendor):
6. **Watcher writes to Supabase** as it sees each trade (it already decodes every curve/pool trade + graduation
   within ~1 s on EC2 and holds the sb_secret key): upsert `trades` with the same row shape as the indexer
   (`curveTradeToRow` / `routerSwapToRow` / `pairSwapToRow` in `supabase/functions/_shared/indexer.ts`, conflict on
   `tx_hash,log_index`, so both writers stay idempotent) and `tokens` on Launched / Graduated. Stored data is then
   current within ~1 s; the indexer cron becomes the gap-filler (every 10 min instead of every minute, ~90% fewer
   function calls). The row builders are Deno code: move the pure functions into a module both Node and Deno import.
7. **Holdings table**: index ERC-20 `Transfer` events of every launched token (+ USDC) into
   `holdings(wallet, token, balance)`, backfilled from each token's launch block; the watcher updates it live and
   broadcasts changes on a private receive-only realtime channel per wallet (`wallet:<address>`, RLS like
   `trades:%`). Then the header balances (`useBalances` every 10 s + `launchedHoldings`, a multicall of balanceOf over
   EVERY launched token, `app/src/lib/explore.ts:385`) and the order panel (`OrderCard` every 15 s) read Supabase +
   realtime instead of polling the RPC. Native HYPE (gas) leaves no logs: read it on chain only after the user's own
   tx or when a panel opens.
8. **Supabase Pro** before ~200 open tabs at once (free realtime connection cap; Pro 500) or 500K function
   calls/month (Pro 2M).
9. **RPC provider = Conduit Pro** (decided 2026-10-22; QuickNode dropped). Pro $50/month = 1B CUs, 250,000 CU/s,
   autoscaling $0.10 per 1M CUs over, 10 API keys (QuickNode Build was $49 for 80M credits, ~4M calls). Conduit
   runs Elysium and leads the mainnet launch. Mainnet RPC `https://rpc-elysium-mainnet.t.conduit.xyz/<key>` (private
   until launch: needs a key from the Elysium team; chain ID unconfirmed, ~99901). Separate keys for servers, browsers
   and testnet. Watcher on wss + a 30 s gap-filler poll, indexer, functions: an estimated ~11M (100 users) to ~47M
   (10,000 users) QuickNode-credit equivalents/month, a small share of 1B. Before switching: check Conduit's
   `eth_getLogs` block-range limit against indexer `MAX_BLOCKS` 50,000 (Elysium makes ~190 blocks/min) and make the
   watcher's gap-filler interval configurable.
Measured 2026-10-22: logged-out Explore visitor ~8 RPC calls/min; logged-in trader ~40-50/min (balances, positions,
order panel); watcher polling ~136/min. Target after 6-7: a handful per user (quotes while typing + own tx).
Dedicated indexer (The Graph / Goldsky / Envio / Ponder): not now (works at this size; Elysium is new, hosted ones
may not support it). Revisit at mainnet scale; Ponder on EC2 writing into the same Supabase Postgres keeps the app as is.

### Fee split (2026-10-20, final): new NeuriioFees `0xd780…bfea`
Curve fees: **50% Neuriio stakers / 30% KNTQ buyback / 10% creators / 10% treasury** (treasury = Neuriio's own
liquidity at launch). Pool fees unchanged: 40% X-token stakers / 40% Neuriio stakers / 10% creators / 10% treasury.
Replaced with `./script/replace-feevault.sh` on the existing staking + minter (nothing moved; older vaults stay
claimable and listed in `feeVaults`). Docs + app copy updated. (NeuriioStaking / NeuriioPad comments still mention
the old split: they weren't redeployed, so their verified source stays as is.)

### Neuriio cap (2026-10-20): staking side redeployed
The user set the mint to **25 Neuriio per $1** earned by X-token stakers (never more: MAX_MINT_RATE = 25 in
NeuriioMinter), decay after $1M of platform fees (PAPER shape, S = $120M), and a **1B hard supply cap** in the token
(mint reverts past it; the minter cuts the last mint to what's left). The token also gets `lockMinter()` (one-way; call
before mainnet with `freezeMintCurve()`). Redeployed with `./script/redeploy-staking.sh` (router kept, so approvals
stay): staking `0xdf46…c2ab`, Neuriio `0x1cac…d483`, minter `0x9a02…b5db`, fees `0x5cfb…be63`; live test passed on
testnet (39.57 Neuriio for $1.58 earned). Old stakes stay withdrawable in the old staking contract; old vaults stay
claimable. 73 Foundry tests. New launches start at 6,000 virtual USDC (`./script/set-virtual-quote.sh`).

### Review (2026-10-18, Opus): no critical/high fund-loss issues -> NO contract rebuild
- The source verified on Blockscout is identical to the local files for all 10 contracts, and the live wiring is
  right (pad + factory -> current vault, minter approves only it, $NEURIIO minter = NeuriioMinter, wallets set,
  vault USDC = `held`, pad holds no stray USDC). Extra throwaway attack tests passed (deleted after): staking stays
  solvent in USDC and $NEURIIO over 1,024 random runs, every curve buyer can always sell back, USDC sent to a pool's
  address before graduation is burned, a flash-swap callback can't pull anything from staking or the vault.
- **Fixed (scripts + payout bot only; contracts untouched):** `replace-feevault.sh` didn't pass MINTER (failed at
  once); `transfer-ownership.sh` listed the routers (no owner: the handover reverted) and missed NeuriioMinter (now
  $NEURIIO + minter; anvil dry run with a stand-in Safe moved all 7 + the factory, old key locked out);
  `pay-protocol.mjs` misread the replaced USDC vault `0xcb49...` (community layout: hourly error, its 5.08 USDC never
  paid). `deploy-core.sh` is now the one new-world script (`deploy-usdc-world.sh` folded in and removed): saves the
  minter + faucet, keeps any world already in the file as `<file>-<registry>.json`, live test on testnet worlds.
  `deploy-launchpad.sh`, `replace-feevault.sh`, `transfer-ownership.sh` take DEPLOYMENTS + RPC + OWNER_KEY for anvil
  dry runs (all four dry-ran on anvil: ALL CHECKS PASSED).
- **Until go-live:** don't run `deploy-launchpad.sh` on testnet: it points Supabase LAUNCHPAD_ADDRESS at the new pad,
  which breaks launches on the live HYPE app.
- **Mainnet notes:** `freezeMintCurve()` only locks the curve numbers; the owner can still mint $NEURIIO through
  `neuriio.setMinter` or `minter.setVault` (and so take $NEURIIO stakers' USDC share): the multisig (+ timelock) must
  own both, or add a one-way lock. Next rebuild only (not worth a redeploy): NeuriioPlatformToken's comment still
  describes the dropped loss-mint; `IFeeVault` in `src/swap/interfaces.sol` is unused. Accepted risk, unchanged:
  $NEURIIO mint farming (wash trades, or USDC sent straight to NeuriioFees, count as fees).

### Done
- **Contracts on testnet, all verified on Blockscout** (`./script/verify-world.sh`: ALL VERIFIED): test USDC
  `0xe83c...0c7b` (only the faucet wallet mints), registry `0x24dc...2219`, factory `0xf698...3b69`, NeuriioPad
  `0x892b...8d76` (VIRTUAL_QUOTE 1,000 USDC: graduates at ~2,834 USDC raised), staking `0x63e2...709a`, $NEURIIO
  `0x5964...1089`, minter `0x2406...f031`, fees `0x35cc...d6b9`, router `0x86cc...4776` (`./script/redeploy-staking.sh`,
  live test ALL CHECKS PASSED). Full addresses: `deployments/elysium-testnet.json`; the old HYPE world's are in
  `deployments/elysium-testnet-hype.json`.
- **Backend `prepare` DONE (2026-10-17):** `./script/supabase-deploy.sh prepare` ran: the indexer indexes BOTH worlds
  (secret WORLDS), the app still lists the HYPE world (APP_REGISTRY / app_config.registry = `0xd787...84fc`). Checked:
  USDC world indexed from its deploy block (2 launches, 12 trades, USDC amounts, real traders), no errors. Pool trades
  store no `fee` (same as the HYPE world). Tests: `./script/test-supabase.sh` (12), `npm --prefix keeper test` (8).
- **App, local only (`npm --prefix app run dev`, http://localhost:5173), uncommitted:**
  - Explore: edge to edge, cards touching (Hyperliquid-style): Top 25 | chart | trade | stake, Positions full width
    below; resizes with the window (<= 1280px the stake card moves under the trade card; phones keep their layout).
    Cards: 1px #ECDDFF border at 50%, 4px corners, no dots/gradients/shadows. Landing frame + /showcase unchanged.
  - Stake card (`app/src/components/StakeCard.tsx`), split in half: top = the picked X token, bottom = $NEURIIO; Stake /
    Unstake / Claim tabs, #8C7D9F accents; wired 2026-10-18. Phones: a Stake tab in Explore (About / Trade / Stake / Positions).
  - /launch opens on one Launch button (no glow) in a small circle of slowly flickering dots plus a 3-dot-tall band of
    them across the page, level with the button; Launch goes straight to the Sector step (log in first if needed;
    someone who already launched lands on Type). Old two-screen intro removed.
  - Font: Manrope everywhere (was Lilex). The videos in `video/` still use Lilex.
  - The app now points at the USDC world (`app/src/lib/config.ts`: `elysium-testnet.json`, `QUOTE` = USDC at $1).
    Launched tokens are priced in USDC on Explore, Feed, Trending and the account panel.
  - Trade box in USDC through the router (`app/src/lib/trade.ts`, `OrderCard.tsx`): curve and pool, 1% fee, quick
    amounts 5/25/100/250 USDC, silent one-time approval (unlimited, to the router) before the first buy / first sell of
    a token, "Need a little HYPE for gas" when the wallet has none. Checked in demo mode only.
  - Data: the app sends `x-neuriio-registry` with every Supabase read so it lists ITS world before the switch.
    Migration `supabase/migrations/20261018054548_world_header.sql` (token_stats + Top 25 per world; no header =
    app_config as before) **APPLIED 2026-10-18** (Supabase connector): no header still lists the 7 HYPE tokens (live
    site unchanged), the USDC header lists the 2 USDC test tokens.
  - **Wired to USDC 2026-10-18 (local, demo + live reads checked; no real wallet tx from the app yet):**
    - Launch + FTF launch (`lib/launch.ts`, `LaunchCard.tsx`): first buy in USDC (quick 10/50/100, USDC balance,
      "Graduates at $13,696 mcap", 1% fee); approves exactly the first buy's USDC to the pad, then
      `launch(pass, sig, quoteIn, minOut)`. Until the switch the backend still signs passes for the HYPE pad: the app
      stops with "launching opens at go-live" instead of sending a tx that would revert.
    - Creator fees in USDC (Explore header, profile modal, Feed, Account box): 10% of pool fees, every vault summed.
    - Stake boxes (`lib/stake.ts`, `StakeCard.tsx`): stake / unstake / claim on both halves, Max, earned USDC +
      $NEURIIO re-read every 5 s, one silent unlimited approval per X token, "Opens after graduation".
    - $NEURIIO box in Account (under Creator fees): staked amount, USDC earned + Claim, unstaked wallet amount.
    - Platform fees widget (user, 2026-10-18: Explore, above the Top 25): lifetime `totalFees` of every vault in
      `feeVaults`, refreshed every 15 s; hidden on the landing / showcase.

### What's left (in order)
Done 2026-10-18: step 2 docs (GitBook live: 1% USDC fees + split, new Staking page, new contracts) and the go-live
switch (`supabase-deploy.sh switch`: launch passes for the USDC pad, app_config + no-header API = USDC world; then
everything pushed, Railway redeployed app + watcher).
1. **Test USDC faucet (built 2026-10-18):** one claim (button under the launch card: "Get testnet funds") pays each X
   account, once each, 0.2 HYPE + 1,000 test USDC from the faucet wallet's balance (`ftf` claimHype; table
   `usdc_claims`; accounts that already took the HYPE see "Get 1,000 test USDC"). Function + table are live; the new
   button ships with the next push. Fund / top up the faucet: `./script/mint-test-usdc.sh faucet <amount>`. **2026-10-19:** 50,000 test USDC per account (every USDC claim reset once; faucet holds ~100.5M); new launches start at 6,000 virtual USDC (`./script/set-virtual-quote.sh 6000`: graduate at ~$82k market cap, ~$17k raised).
2. **A real launch / trade / stake / claim from the app** with a wallet holding test USDC (user, in their browser).
3. Tell testers the old HYPE tokens are gone; remove the Privy LAN origin `https://192.168.0.64:5174`.

Mainnet only (later): multisig ownership incl. the $NEURIIO minter + `freezeMintCurve()`, Fable audit, real bridged
USDC, legal review.

## Earlier plan (written 2026-10-12; videos + public testnet opening)

**The app is built and ready for the public testnet launch.** "Launch" = public launch on Elysium **TESTNET**; mainnet
is a few weeks out and only if users and demand show up (memory "launch-is-testnet"). Multisig + formal audit are
mainnet work, not launch blockers.

**Schedule (user):** Mon 10-12 launch video + thesis post (docs only); Wed 10-14 "How a launch works" video;
**Fri 10-16 the app opens to the public on testnet** (go-live switches below). FTF video any day. Posts come from
@Neuriio; the user quotes them from their personal X. Feedback channel = the user's X + @Neuriio (Telegram later; the
footer Telegram icon stays "coming soon"). The "try it, tell us what's broken" ask starts only in the post that opens the app.

**NEXT CHAT, IN THIS ORDER (user, 2026-10-12):**
1. **3D dot clips 2, 3 and 4** (5 s each, plans below, already agreed with the user). Clip 1 (helix) is DONE. Build one
   clip at a time, render, send, get feedback, then the next. Technical notes in "3D dot clips" below.
2. **Video B "Live on testnet"** for Fri 10-16 (the app opening): plan it second by second with the user before
   building (memory "plan-video-before-building").
3. Post copy only if the user asks (they mainly want video). Build copy from the thesis (memory "neuriio-thesis").
   Content doc: Claude Doc "Neuriio launch content: Oct 12–16"
   https://claude.ai/code/artifact/8243ce06-32c0-4c72-abd5-f330b843eb20 (its 45 s script is superseded by the Remotion videos).

**Go-live switches (Fri 10-16, when the user says go; the user flips these):**
- ~~Delete the Cloudflare redirect that sent `app.neuriio.xyz` to the docs~~ **DONE 2026-10-12** (the landing is live there).
- Remove `APP_PASSCODE` on Railway (service `Neuriio`) -> the App button goes straight in.
- Switch the `neuriio.xyz` redirect (Cloudflare rule "soft launch") from the docs to the app.
- **Remove `https://192.168.0.64:5174` from Privy's allowed origins** (added 2026-10-10 for phone testing).

**Reminders for the user (memory "pending-reminders"):** move contract ownership to a multisig + formal audit (Fable)
before mainnet; decide the points reset (see "Points").

## 3D dot clips (Remotion + three.js; LOCAL ONLY in `video/`, never commit)

Series of 5 s clips, 16:9, 2560x1440 @ 60 fps rendered at 1.5x = 3840x2160. All share:
- **Background:** the app's new look, `#120c1d` with the flat, still lavender dot grid
  (`radial-gradient(rgba(129,114,152,.35) 1.8px, transparent 1.9px) 0 0 / 36px 36px` = the app's 20 px grid at video
  scale). Copy `AppBackground` from `video/src/scenes/Helix3D.tsx`.
- **Dots:** white, like the app's side strands, sized and faded by depth; accent = brand lavender `#ecddff`.

**Clip 1 — dot helix: DONE 2026-10-12.** Composition **"Helix3D"** (`video/src/scenes/Helix3D.tsx`), file
`video/out/helix-3d-4k.mp4` (24 MB). The app's side strand (`app/src/components/DnaStrand.tsx`: radius swells and
pinches, 4.5 lobes, flattened cross-section twisting 1.6 turns) as 14,000 three.js points. 0-1 s grows up from the
bottom while turning; 1-2.5 s camera orbits a quarter turn; 2.5-4 s camera rises over the top and looks down the strand
(spiral tunnel) while a lavender wave runs up it; 4-5 s back to the side view. User has not given feedback yet beyond
moving on.

**Clip 2 — dot-grid terrain (TO BUILD):**
- 0-1 s: the flat background dot grid tilts back into a 3D floor running to the horizon.
- 1-4 s: the camera glides low over it; three "buy" ripples spread from random points, lifting the dots like water
  and lighting each dot they pass (lavender).
- 4-5 s: the camera rises and the floor settles flat.
**Clip 3 — dots form the logo (TO BUILD):**
- 0-1.5 s: thousands of dots drift in 3D space, the camera drifting slowly through them.
- 1.5-3 s: they swirl in and lock into a 3D Neuriio mark.
- 3-4 s: the mark holds and turns slightly, catching the light.
- 4-5 s: it bursts back into a drifting cloud.
- Logo source: `app/public/brand/mark.png` (480x295, the mark with a light outline; no SVG exists). Sample its opaque
  pixels into target points (+ a little depth/extrusion); the new logo tile is `app/public/brand/logo.png`.
**Clip 4 — dot tunnel (TO BUILD):**
- 0-3.5 s: the camera flies forward through a tunnel of dot rings; rings light up as it passes, speed builds.
- 3.5-5 s: it bursts out of the end onto the flat dark background with the logo tile in the centre.

**How to build them (learned on clip 1):**
- Deps installed in `video/` (exact versions): `@remotion/three@4.0.534` (= remotion's version), `three@0.178.0`,
  `@react-three/fiber@8.18.0`, `@types/three@0.178.0`.
- Pattern: `<ThreeCanvas width height camera gl={{ alpha: true }}>` over an `AbsoluteFill` background; a `<points>` with a
  `BufferGeometry` (static per-dot attributes) + `ShaderMaterial` (positions, size, alpha computed in the vertex shader
  from uniforms). Set the camera from `useThree()` inside the canvas each frame (`position`, `lookAt`).
- **GOTCHA (cost a full broken render):** three.js reads a ShaderMaterial's `uniforms` object ONCE. Create it with
  `useMemo` and mutate `.value` every frame; passing a new object each render works in `remotion still` (one frame) but
  freezes every frame of a video at its first value.
- **Render with `--gl=angle`** (without it nothing draws headless). Point sizes are in device pixels: multiply by
  `window.devicePixelRatio` (uniform `uPx`) so 4K renders keep the look; cap the size so close-up dots don't blob.
- Quick checks: `npx remotion still Helix3D out/x.png --frame=120 --scale=0.5 --gl=angle`, or render the whole clip at
  `--scale=0.25` and tile frames: `ffmpeg -i out/x.mp4 -vf "select='not(mod(n\,30))',scale=400:-1,tile=5x2" -frames:v 1 t.png`.
  4K: `npx remotion render <Id> out/<name>-4k.mp4 --scale=1.5 --crf=16 --gl=angle`.

## Videos (Remotion; `video/` is LOCAL ONLY: listed in `.git/info/exclude`, never commit or push it)

Remotion = React/TS video from code, free licence (Neuriio <= 3 people). Higgsfield, Jitter and Figma were dropped.
`cd video && npm run studio` to preview. Base 2560x1440 @ 60 fps; 4K = `--scale=1.5 --crf=16`; 1080p = `--scale=0.75`;
low-res check `--scale=0.25` (0.35 gives a fractional height). Memory "launch-video-remotion" + "plan-video-before-building"
(agree each beat second by second with the user before building; they want lots of motion). Finished, all in `video/out/`:
- **Launch video** (Mon 10-12): `neuriio-launch-4k.mp4` (14.3 s; backup `neuriio-launch-1080p.mp4`), composition
  **"Cards"**: dot-grid ripples -> five X profile cards in an arc -> "tokenize accounts" types -> cards merge into the real
  /launch card + app header -> Login, Launch clicks -> "create social markets" -> logo tile with two dot rings.
  Uses real app captures: `node video/scripts/capture-launch.mjs` / `capture-header.mjs` (need the app dev server on
  :5173; re-run if the header or launch card changes; the header capture predates the 2026-10-12 background/logo change).
- **"How a launch works"** (Wed 10-14): `how-a-launch-works-4k.mp4` (9.6 s), composition **"HowItWorks"**: banner card ->
  token -> rides the bonding curve (calm buys, wild burst at the top, camera zoom) -> lock -> logo tile.
- **FTF video**: `ftf-4k.mp4` (11.5 s), composition **"Ftf"**: four X cards bud out of the logo like dividing cells
  (SVG goo filter), close into a 2x2 grid, melt into a token -> caret -> "create an FTF, / put everyone onchain".
  Its background (vertical mirrored purple -> lavender gradient, twinkling dots in the dark bands) is exported as
  `Background({ frame, plain?, quiet? })` from `Ftf.tsx`; plain loop `ftf-background-4k.mp4` (4 s).
- **"Stake creators"** (2026-10-20, for X): `stake-creators-4k.mp4` (7 s), composition **"StakeCreators"**, Manrope:
  big X card slams in -> flips into the token onto the pad -> "Staked" fades in above, holds ~1 s -> everything collapses
  -> "live on testnet" in the middle. (User rejected a "Mine Neuriio" letter scramble; `capture-stake.mjs` is unused.)
- **"final post of this thread"** (2026-10-12): `final-post-4k.mp4` (5 s), composition **"FinalPost"**: the FTF background
  with the line static in the centre (Manrope 800, 168 px, `#2a1f40` since 2026-10-20; was Lilex 600 96 px), no typing; still `final-post-4k.png`.
- **3D dot helix**: see above. Older drafts: "Launch" (2D helix opening), "Storyline".
- Brand for videos: font Lilex; lavender `#ecddff`, `#a99bbd` soft words, card `#1b1428`; X banners in `video/public/x/`.

## The site today (2026-10-12)

**Domains (Cloudflare):** `app.neuriio.xyz` -> Railway service `Neuriio` (proxied, SSL Full Strict) — **public since
2026-10-12** (redirect rule deleted). `docs.neuriio.xyz` -> GitBook "Neuriio Docs" (Git Sync with `docs/` on `main`;
pull before editing docs, GitBook edits arrive as "GITBOOK-n" commits). `neuriio.xyz` -> 302 to the docs (rule "soft
launch"; switch to the app at go-live). Testers' Railway URL: `neuriio-production.up.railway.app`.

**Server + passcode gate (`app/serve.mjs`):** static server for `app/dist` with SPA fallback + security headers
(`X-Frame-Options: DENY`, `frame-ancestors 'none'`, HSTS, nosniff). With Railway variable `APP_PASSCODE` set (ON since
2026-10-08) the **app routes** (`/explore`, `/launch`, `/feed`, `/trending`, any extensionless path, and `index.html`
by any spelling) show the "Private Beta" passcode page (centred, no scroll); `/`, `/showcase` and every file stay open.
Correct code = 30-day HttpOnly cookie (HMAC of the passcode; changing it signs everyone out); 10 wrong tries per visitor /
200 overall per 15 min. `/showcase` alone is frameable by our own pages (`SAMEORIGIN`).
Local check of the real server: `.claude/launch.json` "gate" (port 8098, passcode `preview-only`, serves `app/dist`:
run `npm --prefix app run build` first).

### Landing page `/` (built 2026-10-11/12; `app/src/components/Landing.tsx`)
- One screen, no scroll. Background = the FTF video's gradient on a canvas (`LandingBg`): dark purple top and bottom,
  lavender light band (centred on desktop; at 30% height on phones so it sits behind the hero), dots twinkling slowly in
  the dark bands, faint in the light band. Header = logo (no menu), coin marquee, Account + Points (real; signing in keeps
  you on the landing). No footer.
- Hero: "Neuriio" (white), "Tokenize Accounts, / Create Social Markets", "The first un-vampable launchpad / to gain
  exposure to X accounts" (light text on desktop; dark tagline/subline on phones), buttons **App** (`/explore`, passcode
  while it's on) and **Docs** (docs.neuriio.xyz, new tab).
- **Showcase card:** a frame with a `#ECDDFF` stroke and a light running round just inside it (conic gradient, 16 s
  loop). Inside, a still picture of the app: **nothing inside can be clicked** (`inert`, `pointer-events: none`).
  - Desktop: the real `ExploreCard` (Positions hidden), frame bleeds ~80 px off the bottom of the screen.
  - Phones: an iframe of **`/showcase`** = the whole desktop Explore page at 1440x900 (logo + menu, marquee held still,
    Account + Points drawn signed-out, the showcase card, footer links; Positions left out), scaled to the frame's width
    (wide, not tall). `index.html` marks `/showcase` transparent before first paint (no dark flash).
- **Showcase data (fake, fixed; `LANDING` in `app/src/lib/explore.ts`, true on `/` and `/showcase`):** `DEMO = DEV_DEMO
  || LANDING` drives the token lists, chart, trade box and positions; Send stays real (`SendModal` uses `DEV_DEMO`). #1
  token @kntqkid: $7.8M mcap, $1.4M 24h volume, $41.3M all-time, 353 trades/24h, launched 28 days ago (graduated); the rest
  $1M-$28M mcap. Fixed HYPE price `SHOW_HYPE_USD = 40` so numbers read as set. Chart = 32 fixed candles + volume climbing
  with pullbacks (`showcaseCandles`), `fitContent` fills the width; no live feed. Avatars = the logo mark on 7 gradients
  by rank (#1 green).

### App look (2026-10-12)
- **Every app page background = the passcode page's**: `#120c1d` with an even 20 px lavender dot grid (`.app` in
  `app.css`; body `#120c1d`). The dot strands on /launch, /feed, /trending are unchanged (exact colours).
- **New logo** (`app/public/brand/logo.png`, 256 px, from the user's image): header, favicon, Privy pop-up, passcode
  page. The glow behind the header logo tile was removed.
- Chart card glow + dots made faint (`.ex-bg-center`). **TradingView logo off everywhere; "Charts by TradingView" link
  under the chart's right corner** (`ExploreCard.tsx`) = the Lightweight Charts licence credit: keep it.

### Pages (all built)
- **Explore** (`/explore`; unknown paths land here): search, Top 25 by total volume (re-ranked every minute), chart
  (Lightweight Charts v5: market cap in USD, candles + volume, 5m-4H, stored gap-free candles from `token_chart` + live
  trades), order card (curve or pool, exact quotes, 1% min slippage), positions, profile modal, creator fees earned.
  Phones: chart card + one card with tabs About / Trade / Positions.
- **Launch** (`/launch`): intro -> FTF line -> flow (Type: Personal or FTF -> Sector -> Profile -> Launch). FTF = 4 members
  invited by X handle, notifications bell in the Account panel. Phones: steps stack.
- **Trending** (`/trending`): Bonding / Recently graduated / Trending (3-day volume, `trending_tokens()`), three columns
  (phones: tabs).
- **Feed** (`/feed`): posts are still SAMPLES (not stored); real posting is later. Phones: Feed / Notifications tabs.
- Menu: Feed (New), Launch, Trending, Explore, Perps/Spot/Outcome (Coming soon). Footer: X, Docs, Telegram (soon).
- Account panel: balances, deposit address, Send (any token), creator-fee Claim, export key, notifications.
  Points card: real total from the `leaderboard` view (`app/src/lib/points.ts`).
- **Phone testing:** the user checks mobile on the live link after a push (the phone dev server `dev:phone` exists but
  stays OFF unless asked). X login on phones goes through x.com and returns.

## Product (decided by the user)

- **Launchpad (pump.fun model) on Elysium with our own pool.** Pairs with HYPE (pool uses WHYPE). Launching is free (gas).
  1B supply; 793.1M sold on a constant-product curve over virtual reserves (`virtualHype` : 1.073B tokens); the last curve
  buy moves the raised HYPE + 206.9M tokens into our pool (Uniswap V2 fork) and **burns all LP** (0x…dEaD). **Mainnet
  target (user, 2026-10-15): graduate at ~$70k market cap**, priced in HYPE on launch day: graduation FDV = 13.7 x
  `virtualHype` and HYPE raised = 2.83 x `virtualHype` (fixed by the 1.073B / 793.1M split), so
  `virtualHype` = 70,000 / (13.7 x HYPE price), e.g. ~64 HYPE at $80 (raises ~181 HYPE); set it with `setVirtualHype`
  before mainnet launches. Testnet stays 0.1 HYPE (graduates at ~0.29 HYPE raised; testnet HYPE is scarce, user is fine
  with the small market caps there). All USD in the app/indexer already uses HYPE's mainnet price.
  Only the launchpad can create pairs; pre-sent tokens are skimmed; slippage + deadline on every trade; owner pause
  stops launches + buys, **sells stay open**.
- **Fees:** curve 0.75% (20% creator / 80% protocol), pool 0.25% (80% creator / 20% protocol), all into **NeuriioFees**
  in HYPE; protocol share -> 60% community / 40% KNTQ buyback (both `0x10E942585ceBf3dcf8377ff8eC38F2458662EEC3`, the
  user's wallet), paid by `payProtocol()` (`./script/run-pay-protocol.sh`, hourly). KNTQ buyback is manual (buy on
  HyperCore, burn, post txs).
- **"Tokenize Accounts":** X is the only login (Privy, embedded "Neuriio wallet" for everyone). One personal token per X
  account, named `@handle` / ticker `HANDLE`, via an EIP-712 launch pass signed by our backend key after Privy verifies
  the X login. Reserved tickers (HYPE, USDC, KNTQ, NEURIIO, …) can't launch.
- **FTF ("Friends Turned Fam"):** exactly 4 members fixed before launch, creator fees split equally, name + 2-10 char
  ticker, own picture; members need no personal token; 50 launch points per member.
- **Sectors:** Robotics, Quantum, Finance, AI, Energy, Memory, Space -> "How are you active?" (Trader, Meme trader,
  Researcher, Influencer, Builder, Creator); stored in the hashed creator profile.
- **Legal framing:** tokens are MEMES, not investments. Say back / support / trade, never invest / returns; disclaimer
  "no promise of value, creators owe holders nothing"; builders get a "fair launch" / "locked liquidity", never "raise
  money", never equity. Legal review before mainnet.
- **Thesis** (`docs/README.md`, memory "neuriio-thesis"): launchpads evolve by what they give exposure to (memes ->
  stocks/crypto onchain -> **social exposure**); the problem is authenticity; Neuriio = X login, only you can launch you.

## Testnet contracts: the OLD HYPE world (Elysium testnet, chain 99801; now `deployments/elysium-testnet-hype.json`)

The live site still runs on these until go-live; `deployments/elysium-testnet.json` is now the USDC world (see top).
Current core (deployed + verified on Blockscout 2026-10-08, core block 5372584): NeuriioRegistry
`0xd7879e97c6558486ca0a92283d70a46e89ea84fc`, NeuriioFees `0x7e9e5e96c3e99fd201a15e6a33c59aec51a39b2b`, NeuriioSwap
(router) `0x4a85eca6f3ef4a07d049bd1907debb3e8961acac`, NeuriioPad `0xd9943d81b72aa55e52580bbb595af797b04d5e59`,
UniswapV2Factory (ours) `0xd30f539cf731d843534a9e3fe9fec51bb456339c`, WHYPE `0x517f12d5d17c4755fbdf988fe9cc24334c3314c7`,
launch signer `0x25626586434fb2003d12957a1fC4B0fA5EA52886` (key only in Supabase secrets).
Owner of everything: Foundry keystore **`burner`** = `0xef584b1098e12c34d1d85de76285c408ab6917a8` (hot key -> multisig
before mainnet). Older cores/launchpads are retired testnet worlds (see git history).
- **Upgrade-safe architecture:** the core (registry, factory, fees vault, router) is deployed ONCE per network
  (`./script/deploy-core.sh`); upgrades are new NeuriioPad versions (`./script/deploy-launchpad.sh`, retires the previous
  one for NEW launches only; old versions keep trading/graduating). Fee vault swappable (`./script/replace-feevault.sh`,
  old balances stay claimable). Indexer, watcher and app follow the registry, never one address; the app always reads
  `registry.launchpadOf(token)` on-chain before sending HYPE.
- **V2 fork:** `src/swap/v2/` = Uniswap v2-core v1.0.1 (solc 0.5.16, GPL-3.0) with marked "Neuriio" changes (0.25% fee
  taken out to the vault as WHYPE; createPair only by the token's launchpad); `./script/v2-diff.sh` prints the diff.
- **Verify:** `forge verify-contract ADDR PATH:NAME --chain 99801 --verifier blockscout --verifier-url
  https://elysium.kinetiq.xyz/api/ --compilation-profile default|size --constructor-args ... --watch` (`size` for
  NeuriioPad + NeuriioToken; args in local `broadcast/*/run-latest.json`). Later tokens/pools auto-match.
- **Multisig handover READY:** `./script/transfer-ownership.sh <safe> [account]` (Ownable2Step on registry, every pad,
  every fees vault; factory `feeToSetter` last, only to a deployed Safe with threshold >= 2; writes
  `deployments/accept-ownership.json` for Safe Transaction Builder); `check <safe>` = read-only report; fork-tested.
  **Blocker: Safe isn't deployed on Elysium.** Decision (user, 2026-10-13): **we deploy Safe ourselves** (not waiting on
  Kinetiq): the official Safe contracts (singleton, proxy factory, fallback handler, MultiSend) on Elysium, then create
  the Safe (2+ signers) and use safe-cli to sign the accept-ownership batch. No contract redeploy needed for the handover
  (Ownable2Step, same addresses, verification stays). Not moved: the launch signer and the fee wallets.

## Backend (Supabase project "Neuriio", ref `yviymgfgaepmtijgyyyo`; Railway project `lively-renewal`)

- **Supabase:** tables users (private), tokens, trades, candles, creator_profiles, ftf_drafts/members, points_ledger;
  views `token_stats`, `leaderboard`, `top_tokens_live`; RPCs `token_chart`, `trending_tokens`. Edge Functions
  `launch-pass`, `register` (called after every X login), `ftf`, `indexer` (pg_cron every minute: launches, trades,
  graduations, router `Swapped`, HL builder fills). Claude has the Supabase connector: `apply_migration` for DDL (then
  rename the local file to the recorded version), `execute_sql` for reads/fixes.
- **Watcher** (`keeper/watcher.mjs`, Railway service `watcher`): broadcasts each trade on private Realtime channels
  `trades:all` / `trades:<token>` as its block lands (charts + positions update ~1-2 s after a trade). ONE instance only
  (the hypedexer websocket allows one per IP); never also run it on the Mac. Pool trades can arrive split (Sync / Swap /
  Swapped in separate batches): `completePoolTrades` rebuilds them from the tx receipt.
  **If live updates lag again:** `railway logs -s watcher` (every trade logs `ev="trades"`), a Node listener on
  `trades:all` with the anon JWT, then check what the chart does with each live trade.
- **Railway:** service `Neuriio` (root `Dockerfile`, builds `app/` with `VITE_PRIVY_APP_ID`, serves with `serve.mjs`,
  `PORT=8080`, `APP_PASSCODE`) + service `watcher` (`RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile.watcher`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` legacy service_role). Use the **Railway CLI** (connector never loads); Claude
  reads logs/variables, the user runs deploys and variable writes (memory "railway-access").
- **Realtime keys:** viewers use the legacy anon JWT, the watcher the legacy service_role key (new keys failed). Re-test
  when Supabase retires legacy keys.

### Points
Rules in `points_rules`: launched tokens (curve + pool) **100 pts per $100k** (raised 2026-10-10, new trades only), HL
via Neuriio 75 per $1M, 50 per launch (+50 per FTF member). Catch: launch points are per TOKEN, so testnet redeploys
credited @von_hl 4x and @__HLOS 2x. **User to decide:** launch points once per X account ever, and/or reset
`points_ledger` at the beta start and at mainnet. Later: Points panel boxes + leaderboard page.

## Running things

```bash
npm --prefix app run dev            # app on http://localhost:5173 (use localhost, not 127.0.0.1: Privy). ?demo = sample data (dev only)
npm --prefix app run build          # app/dist (what Railway serves); typecheck: npm --prefix app run typecheck
forge test                          # contracts; forge build --sizes must stay green (NeuriioPad uses the 200-run "size" profile)
cd keeper && npm test               # keeper tests
./script/test-supabase.sh           # Edge Function shared logic
./script/run-pay-protocol.sh burner # hourly protocol-fee payout (hosting later)
./script/deploy-launchpad.sh burner && ./script/supabase-deploy.sh   # contract upgrade flow (then restart the watcher)
./script/launchpad-test.sh burner   # live: launch -> buy -> sell -> graduate -> router swaps (burner needs ~0.35 HYPE)
./script/hype-to-elysium.sh burner [amount]   # HyperCore HYPE -> HyperEVM -> Elysium (~70 s)
cd video && npm run studio          # videos (local only)
```
Keys: **never paste a private key into chat**; the user types keystore passwords into a terminal tab.

## Hard-won facts (don't rediscover these)

- **Elysium:** HyperCore read precompile + `ElysiumCoreWriter` are NOT live (~4 weeks after mainnet). Solidity
  `block.number` = HyperEVM's height (use ArbSys); `block.timestamp` 1 s resolution, trails by 1-2 s; blocks only with
  txs (~0.16 s apart under load). Official RPC has no websocket; hypedexer (`wss://elysium-testnet-rpc.hypedexer.com/`)
  allows one websocket per IP. The RPC returns 403 to Python's default user agent. A plain HYPE transfer costs ~21.9k gas.
  viem's receipt polling defaults to 4 s: set `pollingInterval` (app uses 300 ms).
- **Bridging:** HyperEVM -> Elysium ~1 min; **Elysium -> HyperEVM waits for a rollup checkpoint (~25 min measured)**.
  No direct Elysium <-> HyperCore path; tokens hop through HyperEVM.
- **"Graduating to HyperCore" (Kinetiq docs, re-checked 2026-10-11):** optional, not a pool: Elysium token -> mirror
  bridge (lock on Elysium, 1:1 on HyperEVM, permissionless) -> HyperCore via a deposit wallet after the issuer's spot
  deployment ceremony: win the ticker (Dutch auction ~31 h, **max 6 chars**), deposit wallet, one-shot genesis, permanent
  link, optional listing. Bridged tokens disable Hyperliquidity, so the book starts EMPTY (no liquidity needed, but
  nobody can trade until someone makes markets). The deployer can set a share of that pair's HyperCore fees. Deposit-wallet
  contracts are pre-launch. Our curve -> our pool graduation is unaffected; HyperCore would be an optional later tier for
  big tokens (per-token ticker cost, multi-day setup).
- **Kinetiq:** runs no pool/DEX; 25% of sequencer fees go to apps using Elysium blockspace — **ask Kinetiq how to apply**
  (also: mainnet date, Safe on mainnet, builder incentives).
- **Hyperliquid:** API limit 1,200 weight/min/IP (allMids 2, clearinghouse 2, metaAndAssetCtxs 20). Coin icons from
  `app.hyperliquid.xyz/coins/<COIN>.svg` are copied into `app/public/` (never hotlinked).
- **App/dev:** installing an npm package while Vite runs can load two Reacts (blank page): `vite.config.js` dedupes;
  if it recurs `npm --prefix app run dev -- --force`. The Browser pane can't do X OAuth (user tests logged-in states
  in their own browser); hidden panes pause animations. Privy needs HTTPS off-localhost.
- **Supabase:** pg-safeupdate rejects DELETE without WHERE; Postgres grants EXECUTE to PUBLIC by default (revoke on
  internal functions); `_` is a LIKE wildcard (escape handles).

## Security status
- Quick reviews done (2026-09-29/30, Opus): contracts — no critical/high findings; fixes shipped for candle-write
  access, wallet<->X privacy, LIKE-wildcard matching, rate limits, fee-vault replaceability, on-chain launchpad check.
  Biggest trust point: `LAUNCH_SIGNER_KEY` in Supabase secrets (a leak = passes for any handle; rotate via
  `setLaunchSigner`). Owner powers (approve versions, redirect future fees, pause buys, reserved tickers, signer) touch
  no existing balances.
- **Before mainnet:** formal audit with the highest model (Fable; memory "audit-preference") -> public
  `docs/ARCHITECTURE.md` + `docs/SECURITY_AUDIT.md` -> professional audit + bug bounty; multisig + timelock;
  Supabase Pro; legal review. (Payout bot hosting: done, EC2 2026-10-22.)
- **Pool SELL fee: FIXED IN CODE 2026-10-22, ships with the mainnet deploy (see NEXT SESSION).** Found 2026-10-22: pool buys pay exactly 1% (1,085 trades,
  $11.15M -> $111.5K), pool sells only **0.348%** (468 trades, $9.24M -> $32.1K), the whole ~$60K gap between platform
  fees ($152.9K) and 1% of volume ($212.8K). Cause: `_takeFee` (`src/swap/v2/UniswapV2Pair.sol:221`) charges 1% of
  the INPUT; on a sell that's 1% of the tokens valued at the post-swap price (`ft * (y - fq) / x`), so a big sell into
  a thin pool pays almost nothing (worst: a $646,759 sell paid $35). Data is fine: every pool trade has exactly one
  on-chain `FeeTaken` and the indexer's volume (USDC out on sells) is right. Fix for mainnet: sells pay 1% of the USDC
  they receive (fee from the quote output; buys unchanged), then check the K math, tests and the audit. Pairs can't be
  upgraded, so it ships with the mainnet factory + pair (+ router); testnet stays as is. Until then the docs' "every
  trade pays 1%" is only true for buys and curve trades.
- Open: when posts become real, the Send recipient must come from `users` server-side; FTF launch points can be farmed
  with extra FTFs (user informed); balances read every token per viewer every 10 s (index holdings server-side at scale).

## Paused / later
- **PropAMM + one-click HyperCore trading stack: PAUSED until capital**, removed from the tree 2026-10-08; restore with
  `git checkout 9fcfe57 -- archive/propamm` (stored as `.txt`). Its testnet contracts sit idle. Design notes (EIP-7702
  one-click buys, FastBridge, wallet findings) are in the old handoff (`git show a73300e:HANDOFF.md`, §§1-9).
- Later: real Feed posting, Points boxes + leaderboard page, X app under the Neuriio account for login (consent screen
  says "Privy" today), pitch deck, fast-exit bridge idea, KNTQ buyback automation.

## Working preferences (memory)
Build UI one element at a time in the user's order; mobile changes apply only to mobile unless the user says otherwise;
**commit/push only when the user says so, never ask**; plan videos second by second first; say up front when a design
won't work with users' wallets. Commits authored `von <von@hlos.org>`; GitHub CLI account `finding-agi`.
