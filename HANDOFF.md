# Handoff — Neuriio (state as of 2026-09-28: launchpad + launch UI done; next: Explore page)

Read this first in a new session. `README.md` has per-step detail; this file is the current truth.

**Project name: Neuriio.** Local folder `/Users/von/Neuriio` (renamed from `elysium`); code lives in the
**private** GitHub repo **https://github.com/finding-agi/Neuriio** (renamed from `finding-agi/elysium`; old URL redirects).

## 0. PIVOT 2026-09-27: token launchpad (pump.fun model); PropAMM PAUSED

**PropAMM is paused until we have capital** for its reserves + hedge margin. Code moved to `archive/propamm/` as `.txt`
(see its README; deployed testnet pools are untouched and idle). **In its place:** a pump.fun-style **launchpad** on Elysium
with **our own swap** (like pump.fun's PumpSwap). Decided by the user:
- Launched tokens pair with **HYPE** (native; the pool uses **WHYPE**). **Launching is free** (gas only).
- **0.75% fee** on bonding-curve trades (was 1%; changed 2026-09-27; accrues in `Launchpad.feesAccrued`, owner withdraws). This product takes a per-trade fee,
  unlike the subscription model below. Graduated pools charge **0.25%** per swap (0.20% stays in the pool, 0.05% to the factory `feeTo`).
- **pump.fun graduation numbers:** 1B supply; 793.1M sold on a constant-product curve over virtual reserves
  (`virtualHype` : 1.073B tokens); when the last curve token sells, the same tx moves all raised HYPE + the remaining 206.9M
  tokens into our `SwapPair` and sends **all LP tokens to 0x…dEaD (burned)**. Pool opening price = curve closing price.
  **Mainnet default `virtualHype` = 60 HYPE** (double pump.fun's shape, user 2026-09-27): graduates at ~170 HYPE raised and
  ~822 HYPE fully diluted market cap (~$74k at HYPE $90). Both scale linearly with `virtualHype` (owner-settable, new launches only).
- Safety built in: only the launchpad can create pairs (nobody can open the pool first at a bad price); tokens/WHYPE pre-sent to
  the predictable pair address are skimmed to 0x…dEaD before the LP mint; slippage + deadline on every trade; owner pause.
- Code: `src/launch/{Launchpad,LaunchToken}.sol`, `src/swap/{SwapPair,SwapFactory,SwapRouter,WHYPE,interfaces}.sol`
  (SwapPair = Uniswap V2 ported to 0.8, V2-compatible interface so aggregator V2 adapters work; flash-swap callback `swapCall`).
  Tests: `test/Launchpad.t.sol` (17 incl. a solvency fuzz).
- **DEPLOYED on Elysium testnet 2026-09-27** (`VIRTUAL_HYPE` 0.1 HYPE → graduates at ~0.29 HYPE, kept small for the burner's budget; fee set to 0.75%; owner + swap `feeTo` = burner):
  Launchpad `0x3a4b7a2604918ce8a4a055d353056f988355b98a`, SwapRouter `0x834ef7af43877a2338ccad5557656cb22d2508dd`,
  SwapFactory `0x37fb29baae25a559653b212dbf3f513c04ec418f`, WHYPE (ours) `0x517f12d5d17c4755fbdf988fe9cc24334c3314c7`.
  **Live test passed** (`./script/launchpad-test.sh burner`: deploys if missing, then launch → curve buy → sell → graduate →
  LP 100% at 0x…dEaD → router buy/sell): token TDOG `0xf016…1C14`, graduated pool `0xD9F0…28Ab`. A plain HYPE transfer on
  Elysium costs ~21.9k gas (not 21k): the first run's refund failed, stranding **~0.34 testnet HYPE** in throwaway trader
  `0xBe2D…F7F0` (key gone); script fixed (40k gas limit; prints the key if the refund ever fails).
- FastBridge / NeuriioAccount now use `src/interfaces/IUsdcPool.sol` (same ABI as PropAMM; bridge tests use `test/mocks/MockUsdcPool.sol`).
  Without PropAMM, one-click buys can only be paid in USDC (launched tokens have no HyperCore market).
- Not built: pump.fun-style creator fee share, router add/remove liquidity (only the launchpad adds LP), exact-output buys,
  keeper/app integration (launch page, curve progress bar, live trades from `Trade` events).

### Fees + creator rewards (user, 2026-09-28) — BUILT (90 tests), DEPLOYED on testnet
- **Every fee a launched token generates → `FeeVault` (`src/launch/FeeVault.sol`), in HYPE: 80% to the token's creator**
  (pull: `claim(to)`; `creatorBalance`, lifetime `creatorEarned[token]`), **20% protocol**, split **60% community rewards
  wallet / 40% KNTQ buyback wallet** (`communityBps` owner-settable; creator 80% is a constant). Protocol share accrues until
  the owner sets wallets (`setWallets`, **user will provide new addresses**, ideally a multisig); then anyone calls `payProtocol()`.
- Curve: Launchpad sends its 0.75% fee to the vault per trade (`feesAccrued`/`withdrawFees` removed; `creatorOf(token)` added).
- Graduated pools: **the full 0.25%** leaves the pool as WHYPE right after each swap (`SwapPair._takeFee` → vault
  `notifyPoolFee`, unwrapped to HYPE) → creator 0.20%, protocol 0.05%. Trader outputs stay exactly V2's (aggregator adapters
  unaffected); k never drops below pre-swap (proof in code + fuzz). V2 `feeTo`/`kLast` protocol fee removed; factory now has
  `whype` + `feeVault` (set once).
- **KNTQ buyback: MANUAL for now** (fees are HYPE on Elysium; KNTQ's market is HyperCore spot @334; no atomic path): buy on
  HyperCore spot, send to a dead address, post txs publicly. Automate later.
- "Platform fees" = the protocol 20% (+ the tiny HL builder fee, off-chain, which only attributes orders for points).
- **DEPLOYED 2026-09-28** (see CURRENT testnet set below). Redeploy: `./script/deploy-launchpad.sh burner` (records `feeVault`; env COMMUNITY_WALLET/BUYBACK_WALLET optional) →
  `./script/supabase-deploy.sh` → `./script/launchpad-test.sh burner` (now checks creator earnings + claim). **Burner has
  ~0.33 HYPE; the live test funds 0.35 → top up first.** Anvil dry run passed. Not indexed yet: FeeVault events (creator
  earnings UI), no app claim button yet.

### FTF: "Friends Turned Fam" (idea, LATER)
Combine 4 creators into one FTF. User's sketch: price it at the average market cap of the 4; every party must agree by signing;
they create a new pool with their own liquidity on our swap. Not designed/built. Intro copy already mentions it.

### "Tokenize Yourself" (user, 2026-09-27): who can launch
**Legal framing (decided 2026-09-27): tokens are MEMES, not investments.** "Thesis / why invest in me / proof" was renamed
to a **creator profile** ("about" + "links" to their work) everywhere (contract `profileHash`, table `creator_profiles`,
function body `{ category, profile: { about, links } }`). UI copy rules: say back / support / trade, never invest / returns;
disclaimer that tokens are memes with no promise of value and creators owe holders nothing; creators get no allocation or
revenue share; creator rules against promising pumps/returns/buybacks (+ ability to hide profiles). Legal review before mainnet.
(Older notes below that say "thesis" mean this profile.)
Theme: invest in yourself, bring your following on board. **X is the only login** (app `loginMethods: ["twitter"]`, done 2026-09-27;
also turn off other methods in the Privy dashboard). Every user who logs in with X can launch **exactly one token, of themselves**:
- **CURRENT testnet set (2026-09-28, creator rewards / FeeVault):** Launchpad `0x88d474bbff6434b12d4d1cdd80d9dc6908e6a502`,
  FeeVault `0x49a8fb439ef9565665e9f326b5372d71e5ce1cc1` (wallets NOT set yet: protocol share accrues), SwapRouter
  `0x8553c72aba22f3969220ffbac1fa296190b0da0d`, factory in deployments; indexer from block 554838. Deployed as the user's
  "reset" (their @von_hl test launch was on the previous launchpad; Supabase rows for the old tokens/trades/launch points
  were cleared, the users row kept). Full live test NOT re-run on this set (burner ~0.30 HYPE, test needs 0.35).
- *Superseded 2026-09-28 (no FeeVault):* Launchpad `0x1cc0838a1344577f5fb4547be8dd72456c3bc97e`,
  SwapFactory `0x9ea7d4961f3d6c2d3e2f33f45674df505778a056`, SwapRouter `0x062737c7ad042bc47a810aed2d1d97d2efba1d3c` (emits
  `Swapped`), same WHYPE + launchSigner; indexer from block 541136. Live test passed (`@test_62922022`); Supabase stored the
  token (with `profile_hash`) + 6 trades; a temporary registered user got exactly 50 + 0.0054 points (removed after; trades
  kept, unlinked). Burner ~0.33 HYPE after this: top it up before more live tests (`FUND` env, default 0.35).
- *Superseded (thesisHash):* Launchpad `0xfd4b6e796456e2f76ddcccf46b9dea4c677cb5e1`, SwapFactory
  `0x1e9b4d061e066aeb1ebc6ad743f9885d0738e45a`, SwapRouter `0x6e77ca284ed8727d5d00725bbeccb63d0ce42b57` (WHYPE reused),
  launchSigner `0x25626586434fb2003d12957a1fC4B0fA5EA52886` (key only in Supabase secrets). Supabase schema pushed, secrets
  set, `launch-pass` deployed (rejects missing/invalid Privy tokens: 401 verified). Live test passed (launch `@test_297219980`
  → curve → graduate, LP burned → router). The earlier open-launch set (Launchpad `0x3a4b…b98a`, factory `0x37fb…418f`,
  router `0x834e…d2508dd`) is superseded (fee 0.75%, idle). Not yet tested end-to-end: a real X login calling `launch-pass`.
- **Contract (87 tests):**
  `Launchpad.launch(LaunchPass, signature, minTokensOut)`. The pass is EIP-712-signed by our backend key `launchSigner` after it
  verifies the X login via Privy: `{creator wallet, xUserId, handle, category, thesisHash, deadline}`. Rules on-chain: signer
  must match, `msg.sender == creator`, one token per **X user ID** (permanent; handles can change), per wallet, and per handle
  (case-insensitive). Name = `"@" + handle`, ticker = handle in CAPS (1–15 chars, A-Z a-z 0-9 _). Categories (enum):
  Trader, MemeTrader, Researcher, Influencer, Builder, Creator. `profile(token)`, `tokenOfXUser`, `tokenOfCreator`,
  `tokenOfHandle`; owner can rotate `launchSigner` (address(0) = launches off). Launch stays free with an optional first buy.
  `LaunchToken` no longer has a `uri`.
- **Thesis** (why invest in me + proof): full text/links/images in **Supabase**, keccak256 hash fixed on-chain at launch.
- **Supabase project "Neuriio"** (ref `yviymgfgaepmtijgyyyo`, https://yviymgfgaepmtijgyyyo.supabase.co, us-west-2, free tier).
  In repo: `supabase/migrations/20260927000000_tokenize_yourself.sql` (users [private], `profiles` view, theses, tokens,
  launch_passes [private], trades [curve/pool/hl_perp/hl_spot/hl_outcome], points_ledger + `points_totals` view,
  indexer_state; RLS on, public read-only where noted, writes only via service role) and Edge Function
  `supabase/functions/launch-pass` (+ `_shared/launchPass.ts`): verifies the Privy access token (JWKS), reads X account +
  embedded wallet from Privy's API (app secret), validates category + thesis (50–5,000 chars, ≤10 https proof links),
  pre-checks the chain, stores user + thesis (exact hashed JSON string), signs the EIP-712 pass (15 min TTL).
  viem-signed pass ↔ Launchpad.sol interop verified on anvil. Setup: `./script/supabase-setup.sh` (CLI install, login, link,
  `db push`, creates the signer key INSIDE Supabase secrets and records only its address as `launchSigner` in
  deployments, asks the Privy app secret hidden, deploys). Then `./script/deploy-launchpad.sh burner` (fresh launchpad with
  that signer; updates the LAUNCHPAD_ADDRESS secret).
- **Indexer + points: LIVE 2026-09-27** (migration `20260927010000_points.sql`, functions `indexer` + `register`):
  - **Points rules (user):** launched tokens (curve + pool) **100 pts per $1M** traded; Hyperliquid perps/spot/outcomes via
    Neuriio **75 pts per $1M**; **50 pts** for launching yourself; raw volume (no anti-wash rules); live public leaderboard.
    Holding points: planned, math TBD. Rates live in `points_rules` (points per $1; changes apply going forward only).
  - `award_points()` (SQL): links trades to users by wallet, writes one ledger row per trade / launch (idempotent via the
    ledger's unique key). `leaderboard` view (rank, points, trading/launch split). `try_lock_indexer`/`unlock_indexer`.
  - `indexer` Edge Function, **pg_cron every minute** (`neuriio-indexer`): Launchpad Launched/Trade/Graduated, SwapRouter
    `Swapped` (new event: who traded), pair `Swap`s not via our router (trader = tx.from), and each registered user's HL
    fills that carry a builder fee (`userFillsByTime`, per-user cursor in `indexer_state`). USD = HL **mainnet** HYPE price.
    Secrets: ROUTER_ADDRESS, WHYPE_ADDRESS, INDEX_FROM_BLOCK (537958), HL_TESTNET=true. Scaling note: per-user HL polling
    is fine for now; at scale switch to a websocket or HL's builder-fills data.
  - `register` Edge Function: **the app must call it after every X login** (not wired yet) so non-launchers earn points;
    returns profile, token, points, rank.
  - Verified live: 1 token + 6 test trades indexed with USD values; a temporary test user got exactly 50 + 0.0054 points
    ($54.02 × 100/1M), then removed. `users` is not readable with the anon key.
  - **Builder fee (attribution only):** `app/src/lib/config.ts` `HL_BUILDER` (fee 1 = 0.1 bp on perp/spot/outcome; testnet
    builder = burner, $775 perps value; use a separate account on mainnet). `hub.signBuilderApproval` (setup, silent) +
    `submitBuilderApproval`; `OneClick.buy/buyFromHl({ builderApproval })` submit it with the agent approval. Not yet used by
    any app screen (buy UI not built).
  - SwapRouter `0xAc69…C4F0` (first with `Swapped`) is superseded by `0x0627…1d3c` in the current set.
  - Scripts: `./script/supabase-deploy.sh` (db push + indexer secrets + deploy all functions), `./script/deploy-router.sh`,
    `./script/test-supabase.sh` (Node tests for the shared function code; 6 passing).
  `launchpad-test.sh` now signs with a throwaway test signer (owner swaps it in, restores the real one on exit).
- **HL builder fee returns, tiny, only to attribute orders** (min 0.1 bps; one more silent setup signature `approveBuilderFee`;
  builder account needs 100 USDC perps value).
- Risks flagged to the user: the signer key is the gatekeeper (server secret only); "invest in me" + proof ≈ investment
  solicitation → legal review before launch.

## 1. What this is

A trading app on **Elysium** (Kinetiq's Arbitrum Orbit L2, settles to HyperEVM, testnet chain `99801`)
that gives users one place to **swap on Elysium** and **trade on Hyperliquid (HyperCore)**: perps, spot,
HIP-4 outcome (prediction) markets, using any HyperCore-priced token as collateral.

**Business model: monthly subscription.** No profit is taken per trade:
- the pool prices at HyperCore + hedge cost only (5 bps each side ≈ HL's 4.5 bps taker fee, rounded up to whole bps)
- no builder fee on Hyperliquid orders, no bridge fee
- users pay only Hyperliquid's own fees (incl. HL's one-time **$1** fee when USDC is first sent to a brand-new HL account; passed on, show it in the UI)
- everyone starts on a flat rate; repriced after a month of usage data. **Gating is NOT built yet** (see TODO).

**Model A ("gateway, not house"):** users trade on their **own** HyperCore account. We never custody
their HL funds or take the other side of their trades.

**Positioning notes (2026-09-25):** multi-asset collateral is the hook ("any token is collateral"); the user picked a
Twitter bio from brainstormed options (≤5 words, collateral-themed). PropAMM in one line: our own pool on Elysium that
quotes Hyperliquid's live book ± 5 bps (not a reserve curve) and hedges every fill on Hyperliquid, so users get ~Hyperliquid
prices on Elysium. Today the price arrives via the feeder bot (~2 s lag: 1.5 s pushes + tx inclusion + Elysium's coarse
clock); once Elysium's read precompile ships the pool reads HyperCore in the same tx (sub-second, no bot) — only a new
adapter behind `IHyperCoreOracle` is needed.

## 2. How it fits together

```
User on Elysium
  ├─ Swap HYPE<->USDC ............ PropAMM pool (priced off HyperCore, hedged on HL perps)
  └─ "Open 10x HYPE with my KNTQ"  FastBridge.deposit(token)
        -> pool converts to USDC -> relayer instantly credits the user's OWN HL account from our HL inventory
        -> trade hub places the order on HL (signed by the user's trade-only app key)
  └─ ONE-CLICK BUY (the real UX) .. user's wallet is EIP-7702-delegated to NeuriioAccount; a device session key signs a Buy,
        our sponsor submits it (user never pays gas) -> FastBridge -> relayer credit -> agent moves USDC perps->spot
        if needed -> agent places the order. No wallet prompt after two one-time setup approvals.
  └─ Withdraw ..................... user usdSends to our HL inventory account -> relayer pays out on Elysium
```

Bots (off-chain, `keeper/`): **feeder** (HyperCore prices → oracle), **hedger** (keeps HL perp short = pool's HYPE),
**relayer** (runs the bridge), **sponsor** (HTTP service that pays gas for one-click setup/buys; optional in run-bots). The bridge never moves tokens across chains; it pays out of our own inventory on
each side ("a cash drawer in both countries") and we rebalance slowly.

## 3. Roadmap status

| Step | What | Status |
|---|---|---|
| 1 | HyperCore price oracle (`KeeperHyperCoreOracle` + `HyperCoreReader`) | ✅ live on testnet |
| 2 | PropAMM pool | ✅ live on testnet |
| 3 | Hedger | ✅ runs **simulated** on testnet (pool is priced off *mainnet* HYPE; testnet HYPE is a different market) |
| 4 | FastBridge + relayer | ✅ live on testnet, real HL testnet USDC, round trips verified |
| 5 | Trade hub backend (`keeper/src/trade/`) | ✅ real fills verified on HL testnet |
| 5b | **One-click backend** (EIP-7702 `NeuriioAccount` + session keys, gas sponsor, `OneClick` client, auto perps↔spot USDC) | ✅ **live on testnet 2026-09-25**: zero-gas wallet → 3x BTC filled in 13 s, PURR spot filled in 10.4 s, all withdrawn |
| 5c | **Wallet: Privy "Neuriio wallet"** (sign up with X or any wallet → Privy embedded wallet → 7702 to `NeuriioAccount`) | ✅ **verified on testnet 2026-09-25** via `app/` check page: X login → wallet auto-created → setup with **zero pop-ups** (4.7 s) → 3x BTC filled in 13.3 s → withdrawn, 0 gas ever held. Speed fixes landed after (not yet re-timed) |
| 6 | **UI** | **in progress** (2026-09-26/27): app shell, top bar, account + points panels, live ticker marquee, social footer built in `app/` (§10). Center card (the one-button buy) NOT started |
| 6b | **tKNTQ/tUSDC PropAMM** (2nd pool, so KNTQ can pay for one-click buys; ~$100 test trades) | ✅ **deployed 2026-09-27** + registered with FastBridge; **$100 test swap not yet run** (needs bots, §10 step 1) |
| 7 | **Security audit (AI, highest model) → public `docs/ARCHITECTURE.md` + `docs/SECURITY_AUDIT.md`** for the pro audit team | planned (see TODO 6) |
| 8 | **Launchpad (bonding curve) + own swap, LP burned at graduation** (§0) | ✅ **deployed + live-tested on testnet 2026-09-27** |
| 8b | Tokenize Yourself: X-only login, signed launch passes, Supabase (indexer, points), creator rewards (FeeVault) | ✅ testnet 2026-09-28 |
| 8c | **Launch UI** `/launch` (intro → FTF line → 3-step flow) | ✅ done, user-approved 2026-09-28 |
| 8d | **Explore page** (chart + details, handle search, top 25 by volume) | **next** (§10) |
| paused | PropAMM (steps 2, 3, 6b): archived to `archive/propamm/` until capital | ⏸ |
| later | Subscription gating contract; ERC-4626 vault for outside capital | not started |

## 4. Live on Elysium testnet (`deployments/elysium-testnet.json`)

| Contract | Address |
|---|---|
| Oracle | `0x7cf7fe50defd5ef35ecba65e5dcb354a50844028` |
| tHYPE (mock, 18 dp, public `mint`) | `0x365c3257dd6ac46371c4ea357445d57857941eb9` |
| tUSDC (mock, 6 dp, public `mint`) | `0x200e9be287f89b6af24776223f009bf277329c38` |
| PropAMM (HYPE/USDC, prices HyperCore **mainnet** spot `@107`) | `0xcfda6518d10a686dc2d0c1d9934a4a43952a4f9b` |
| FastBridge | `0x4f8730e682c2dd6ea524e4c81323b7a0d2cb7c41` |
| NeuriioAccount (EIP-7702 delegate, stateless, no owner) | `0x78520083cbac74787d733c6de1b177521177ffbb` |
| tKNTQ (mock, 18 dp, public `mint`) | `0x04338abe7d8da8a173bcf5a7e15ba704b1beaad2` |
| PropAMM (KNTQ/USDC, prices HyperCore **mainnet** spot `@334`, edge 8 bps) | `0x4150763bd4c1de8b380d301e5aa4e04b2116639c` |

- **Owner of everything + every operator role:** user's Foundry keystore account **`burner`** = `0xef584b1098e12c34d1d85de76285c408ab6917a8` (~0.91 HYPE gas left).
- **Treasury wallet** (funds the HL inventory; its transfers are top-ups, not withdrawals): `0xe973105a27e17350500926ae664dfcfe6006d924`.
- **Live settings:** pool edge 5 bps, minEdge 5, skew 0, impact 0, maxTrade 10% of pool, depth factor 2×, maxAge 5 s. Oracle clock slack 2.5 s. Bridge fee 0, refund delay 1 h, caps $25k/tx and $100k/day.
- **State at handoff:** pool 106.43 tHYPE + 8,706.52 tUSDC; bridge credit 677.37, free liquidity 221.63 tUSDC; burner HL testnet inventory 777.37 USDC.
- **Bots are STOPPED** (stopped 2026-09-27 for the KNTQ pool deploy). Pools refuse quotes (stale price) until the feeder runs.
  `run-bots.sh` now feeds **two** markets: `MARKETS=107,334` (HYPE/USDC + KNTQ/USDC, HyperCore mainnet spot).
- **KNTQ pool (deployed 2026-09-27, seeded at $0.3367: 5,000 tKNTQ + 1,683.58 tUSDC):** `./script/deploy-kntq-pool.sh burner` deploys mock **tKNTQ** (public mint) +
  **PropAMM tKNTQ/tUSDC** priced off HyperCore mainnet spot **pair 334** (KNTQ/USDC, ~$0.325), **edge 8 bps / minEdge 8**
  (KNTQ has no HL perp → would hedge on spot, taker ~7 bps), seeds 5,000 tKNTQ + ~$1.6k tUSDC (≈$3.2k pool → maxTrade ≈$325),
  calls `FastBridge.setPool(tKNTQ, pool)`, and writes `tKNTQ` + `propAMMKntq` into `deployments/elysium-testnet.json`.
  Not hedged (hedger only runs the HYPE pool; KNTQ needs spot hedging). **The deploy ran twice** (two broadcasts 45 s apart):
  an unused duplicate exists at tKNTQ `0x6e53…850c` / pool `0x697b…a999` (mock tokens only, harmless; not registered: the live
  `FastBridge.poolFor(tKNTQ)` = `0x4150…639c`). `broadcast/DeployKntqPool.s.sol/99801/` also holds a local-fork dry run.
- **Other DEX pools on Elysium testnet (scanned 2026-09-26, blocks 0–332,227):** 23 UniV2-style, 8 V3-style, 3 V4 pools, mostly
  meme/test tokens vs WHYPE/WETH. USDC-side: WHYPE/USDC v3 1% (`0x04cf…8c2d`, 2 WHYPE + 500 USDC), USDC/WETH v2 (`0xfb3a…746a`,
  40 USDC + 0.43 WETH), two "tHYPE/tUSDC" v3 pools of OTHER teams' mock tokens. Prices are arbitrary (up to 30× off). That USDC
  (`0x7d29…47b2`) is canonically bridged from HyperEVM `0x2B33…D8Ab`, NOT Hyperliquid testnet's linked USDC (`0x0b80…c206`).
- Real testnet **KNTQ** is on Elysium at `0x9856148d9CAcf40F12BCAA9357ca016Ba5B0ED19` (18 dp; canonical bridge of HyperEVM
  `0xf57e…1d32` = HL testnet KNTQ token 3167). HL mainnet KNTQ: spot `@334` KNTQ/USDC (also dead `@254` vs USDH), **no perp**.

## 5. Running things

Keys: **never paste a private key into chat.** The user types their keystore password into a terminal tab; scripts
decrypt it in memory only. Claude can start a script in the user's terminal panel (`run_in_terminal`) and read the output.

```bash
TOPUP_FROM=0xe973105a27e17350500926ae664dfcfe6006d924 ./script/run-bots.sh burner   # start bots (Ctrl-C / closing the tab stops them)
./script/smoke-trade.sh burner      # throwaway trader: swap buy + sell on the pool
./script/bridge-test.sh burner      # throwaway trader: bridge in + out
./script/journey-test.sh burner     # swap+bridge -> onboard -> 3x BTC long on HL testnet -> close -> withdraw everything
./script/apply-settings.sh burner   # owner settings (oracle slack, pool pricing)
./script/bridge-fee-off.sh burner   # bridge fee = 0
./script/oneclick-test.sh burner    # zero-gas wallet: 7702 setup -> one-click 3x BTC + PURR spot on HL testnet -> withdraw everything
./script/privy-check.sh burner      # sponsor :8787 + test faucet :8788 for the Privy check page (app/, npm --prefix app run dev -> :5173)
./script/deploy-oneclick.sh burner  # (re)deploy NeuriioAccount only (run with bots STOPPED: same key as the feeder)
./script/deploy-testnet.sh burner   # fresh deploy of oracle + tokens + pool + bridge + NeuriioAccount
./script/deploy-kntq-pool.sh burner # 2nd pool: tKNTQ/tUSDC + FastBridge.setPool (bots STOPPED)
npm --prefix app run dev            # the app on http://localhost:5173 (?demo = logged-in account panel with sample data,
                                    #   dev only; ?check = old Privy testnet check page). Run it in a terminal tab.
SPONSOR_ACCOUNT=<keystore> TOPUP_FROM=... ./script/run-bots.sh burner   # also runs the gas sponsor on :8787 (SEPARATE keystore w/ a little HYPE)
./script/deploy-launchpad.sh burner # launchpad + swap (WHYPE, factory, router); testnet VIRTUAL_HYPE 0.1 HYPE
./script/launchpad-test.sh burner   # live: launch -> buy -> sell -> graduate (LP burned) -> router swaps; deploys if missing
forge test                          # 77 passing (PropAMM's 24 archived; +17 launchpad) (+ fork suite: forge test --match-path 'test/fork/*' --fork-url elysium_testnet, 3)
cd keeper && npm test               # 61 passing
./script/test-supabase.sh           # 6 passing (Edge Function shared logic, under Node)
./script/e2e-bridge.sh              # full local bridge e2e on anvil (no keys needed)
./script/e2e-oneclick.sh            # full local one-click e2e on anvil (7702 setup + sponsored buy + guards)
```

Bot logs: `logs/*.log` (each bot prints `rpc_stats` every minute). Relayer state: `logs/relayer-state.json`.
Scripts auto-retry nonce clashes (the feeder signs with the same account), and only one set of bots should run at a time.
The anvil e2e scripts refuse to start while any `feed-bbo.mjs` runs (conservative guard; they use anvil keys on a local chain).
`foundry.toml` is on `evm_version = "prague"` (needed for EIP-7702; Elysium runs ArbOS 51, 7702 arrived in ArbOS 40).

## 6. Repo map

```
src/interfaces/IHyperCoreOracle.sol   stable oracle interface (swap to Elysium's native precompile later)
src/oracle/KeeperHyperCoreOracle.sol  keeper-pushed prices (bid/ask, sizes within 20 bps, Core time)
src/libraries/HyperCoreReader.sol     freshness / spread guards      ElysiumBlock.sol  L2 block via ArbSys
src/amm/PropAMM.sol                   pool: ask=coreAsk*(1+edge..), bid=coreBid*(1-edge..), no-arb clamp
src/bridge/FastBridge.sol             deposit/markFulfilled/refund, payout, compare-and-set credit
src/account/NeuriioAccount.sol        EIP-7702 delegate: ERC-7821 batching (owner), session keys (caps/expiry/revoke),
                                      buy() -> FastBridge with HL recipient = the wallet itself, ERC-1271 (owner key only)
keeper/feed-bbo.mjs  hedger.mjs  relayer.mjs     bot entry points
keeper/src/rpc.mjs                    shared transport: fallback RPC, batching, backoff, req/min stats
keeper/src/planner.mjs hedger.mjs exchange/     hedging engine (sim + live HL adapter)
keeper/src/bridge/                    relayer logic, chain adapter, HL transfers (live + sim)
keeper/src/trade/                     TRADE HUB — what the UI calls (see §8)
keeper/src/oneclick/                  ONE-CLICK: account.mjs (setup/sign), oneclick.mjs (quote + buy w/ stages),
                                      sponsor.mjs (gas sponsor logic), wire.mjs (HTTP format + SponsorClient)
keeper/sponsor.mjs                    gas sponsor HTTP service (POST /setup, POST /buy, GET /health); kicks the relayer after a buy
app/                                  Vite + React 18 + TypeScript (strict) + Privy. Privy App ID in app/.env.local
                                      (VITE_PRIVY_APP_ID, gitignored; public client id). Imports keeper/src directly.
  src/main.tsx App.tsx app.css chain.ts   entry (Privy: X/Google/Telegram login, embedded wallet for all, themed modal) ·
                                      page layout · ALL styles (brand tokens at :root) · Elysium chain def
  src/components/Morph.tsx            shared "button morphs into panel" (motion spring; Escape/×/outside closes; anchor L/R)
  src/components/CardStack.tsx        top-right layered deck: hovered card springs up + to front, other sinks
  src/components/AccountBox.tsx       Account: logged out = blurred placeholder + Login card (opens Privy); logged in = pfp+handle,
                                      deposit address + copy, Elysium/HyperCore balances, export private key (Privy modal), logout
  src/components/PointsBox.tsx        Points: 8 blank boxes (no points system yet); logged out = blur + "Login to Account"
  src/components/MenuBox.tsx          ≡ menu (no box) → panel: Dashboard / Spot / Perps / Outcome (not wired to pages yet)
  src/components/LogoMarquee.tsx      top-center infinite marquee (reference component, logic unchanged)
  src/components/SocialLinks.tsx      bottom cards: X (x.com/Neuriio), Docs (GitBook, no URL yet), Telegram (no URL yet)
  src/lib/tickers.ts                  marquee data: top-10 HL mainnet perps by volume, 5 s allMids poll, green/red vs prevDayPx
  src/lib/balances.ts useBalances.ts  balances: Elysium (HYPE native+tHYPE, KNTQ, USDC) + HyperCore (HYPE, KNTQ, USDC=spot+perps)
  src/lib/profile.ts format.ts config.ts motion.ts   social handle/pfp · number formats · token addresses · springs
  public/brand/logo.png  public/tickers/white/*.svg  public/social/*.svg   logo (256px) · white ticker icons · footer icons
  src/PrivyCheck.jsx                  old testnet check page (JS), still at ?check
keeper/test/live/                     live scripts used by script/*-test.sh
```

**Contract inventory (2026-09-25):** 4 deployed contracts — KeeperHyperCoreOracle (111 lines / 87 code), PropAMM (353/276),
FastBridge (301/230), NeuriioAccount (211/146) = 976 lines / **~740 code**; plus libraries HyperCoreReader, ElysiumBlock and
interface IHyperCoreOracle (~80 code) → **~820 nSLOC** audit scope (OpenZeppelin imports excluded). Tests ~1,430 lines.
Off-chain money-path code (relayer + sponsor + one-click, JS) ~910 lines. Still to build: subscription contract, ERC-4626 vault.

## 7. Hard-won facts (don't rediscover these)

- Elysium's HyperCore read precompile and `ElysiumCoreWriter` are **not live** (ship ~4 weeks after mainnet). No atomicity between Elysium and HyperCore
  (HyperCore is a separate chain with its own blocks: a Core action executes in a later Core block, after the Elysium tx has finished).
- **Every on-chain Elysium → HyperCore path** (Elysium docs, checked 2026-09-24, https://elysium.kinetiq.xyz/docs):
  - *Actions:* only `ElysiumCoreWriter` (not live). Contract emits an order intent → keeper (Kinetiq's or our own agent) signs and
    submits it, ~100–200 ms / ~1 Core block. **Place/cancel orders only; cannot withdraw or transfer funds.** Not atomic; optional
    result callback funded by a prefunded HYPE gas escrow (dedupe by intent nonce).
  - *Reads:* native market-data precompile (not live): orderbooks, prices, balances, positions at top-of-block freshness. Replaces the feeder.
  - *Tokens (live, always via HyperEVM):* HYPE native bridge; canonical Arbitrum bridge for HyperEVM ERC-20s; mirror bridge for
    Elysium-native tokens; then HyperEVM ↔ HyperCore escrow linkage (needs a one-time HyperCore spot deployment). Latencies unpublished.
- **What `ElysiumCoreWriter` changes for us:** best win = **on-chain hedging** (pool places its own hedge right after the swap; retires
  the hedger bot, easier to trust/audit). Does **not** replace FastBridge/relayer (can't move funds). App order flow stays direct to
  the HL API (already direct; CoreWriter only adds value when an order must be part of an Elysium tx, e.g. one-click "swap KNTQ + open position").
- **Elysium token bridging (docs checked 2026-09-25, all pre-launch):** no direct Elysium ↔ HyperCore transfer; tokens hop
  through HyperEVM. **Any standard ERC-20** bridges (not just USDC; no fee-on-transfer tokens). HyperEVM → Elysium ≈ 1 min
  (canonical Arbitrum bridge / mirror bridge retryables). **Elysium → HyperEVM waits out the challenge period** (docs:
  "standard optimistic withdrawals"). Read on-chain 2026-09-25 (testnet rollup `0xEbf08e34…39Df` on HyperEVM testnet, via
  router `0x1aAE2caD…7C45` → inbox → bridge): `confirmPeriodBlocks = 10` (seconds), latest confirmed checkpoint was ~14 min
  old. **MEASURED 2026-09-25: 0.001 HYPE `ArbSys.withdrawEth` (tx 0x1118f7…a555) was claimable on HyperEVM after
  ~25 min** (checkpoint cadence, not the 10-block challenge). Elysium's own bridge UI says the same: HyperEVM → Elysium
  "About a minute"; Elysium → HyperEVM "Claimable on HyperEVM once the rollup confirms it". Mainnet values unpublished.
  The 0.001 HYPE is still unclaimed on HyperEVM testnet (burner has no HyperEVM gas). HyperEVM ↔ HyperCore via
  Elysium "deposit wallets" (issuer links each token; factory published at launch). → The native route OUT of Elysium is
  slow; FastBridge (our inventory) is how users reach HyperCore fast. Same-token 1:1 bridge for HYPE/KNTQ/NEST = possible
  FastBridge extension (inventory both sides, no pricing/hedge), not built.
- **App/dev gotchas (2026-09-26):** installing an npm package while Vite runs re-optimizes deps and can load TWO copies of
  React (blank page, "Invalid hook call"). Fixed in `app/vite.config.js` (`resolve.dedupe` react/react-dom + `optimizeDeps.include`);
  if it recurs: restart with `npm --prefix app run dev -- --force` and hard-refresh. The Browser pane can't do X OAuth: the user
  tests logged-in states in Firefox; `?demo` shows the logged-in account panel with sample data. The Elysium RPC returns 403 to
  Python's default user agent (send one, e.g. `curl/8.4.0`). Anvil forks can't run the oracle push (ArbSys stub).
- **Hyperliquid API budget per viewer** (limit 1,200 weight/min/IP): allMids = 2, clearinghouse/spotClearinghouse = 2,
  metaAndAssetCtxs/spotMetaAndAssetCtxs = 20. App today ≈ 26/min (marquee: allMids every 5 s + prevDayPx every 10 min) +
  ≈ 65/min when logged in (balances every 10 s, spot price lists cached 60 s).
- **HyperCore price sources:** `allMids` (one call, all main-dex markets); HIP-3 builder dexes (`xyz` 125 markets incl. stock/index
  perps, `km`, `cash`, …) via `allMids {dex}`; the same ticker can differ a lot between dexes (AAPL xyz $341 vs km $292), pick one.
  HL serves coin icons at `app.hyperliquid.xyz/coins/<COIN>.svg`; we copy what we use into `app/public/` (never hotlink).
- **Elysium bridge UI** (`elysium.kinetiq.xyz/testnet-bridge`): HyperEVM → Elysium "About a minute"; Elysium → HyperEVM "Claimable on
  HyperEVM once the rollup confirms it" (the ~25 min measured above). Validation is permissioned at launch (rollup allowlist on,
  0.1 HYPE stake), BoLD later.
- With the read precompile live, the ~2 s price lag mostly disappears → fewer `StaleByTime` reverts, far less lag-arb risk at 5 bps.
- On Elysium, Solidity `block.number` = **HyperEVM's** height; use ArbSys (`ElysiumBlock.number()`). `block.timestamp` is 1 s resolution and trails real time by ~1–2 s. Blocks only happen when there are txs.
- Foundry forks don't execute Nitro precompiles (ArbSys is a `0xfe` stub) and don't emulate the `block.number` behavior.
- Public RPC rate-limits: bots now use ~155 req/min total with fallback to `https://elysium-testnet-rpc.hypedexer.com/`. viem's `writeContract` silently adds several `eth_fillTransaction` calls. Sign locally + `sendRawTransaction`. Always read with `getBlockNumber({ cacheTime: 0 })` for money decisions.
- HyperCore quirks: `usdSend` needs the **main** key (agents can't move funds); first send to a new account costs **$1**; the `fee` field on fills *includes* builder fees; SDK **throws** on order error statuses (hub handles it); outcome markets use asset id `100000000 + 10*outcome + side`, mids `#N`, balances `+N`, size decimals 5, raw names like `template:priceTouch`.
- HL testnet: **HYPE perp book is one-sided/empty** (test perps with BTC); HL testnet faucet needs mainnet history (user funded the burner from their main wallet).
- Deposits near the 1 h refund window are never sent by the relayer (user may be refunding). Inventory top-ups must come from a `TOPUP_FROM` wallet or they look like withdrawals.
- ~$211 of testnet USDC is stranded in two throwaway accounts from early runs (keys gone). Harmless; tests now always withdraw everything.
  Plus ~0.99 PURR (~$4.50) dust in the 2026-09-25 one-click test wallet, and 0.01 HYPE in each of 3 throwaway sponsor keys from failed runs.
- **EIP-7702 on Elysium (verified 2026-09-25):** type-4 txs work on testnet (ArbOS 51). BUT Elysium's `eth_call`/`eth_estimateGas`
  **ignore `authorizationList`** (the call runs as if the wallet had no code) → simulate with a state override that sets the
  wallet's code to `0xef0100 ++ delegate`, and add 25,000 gas per authorization. The sponsor does this. No ERC-4337 EntryPoint
  (v0.7/v0.8) is deployed on Elysium testnet → no bundlers/paymasters; we run our own sponsor.
- **HyperCore refuses every action (incl. `approveAgent`) from an account that has never received a deposit** ("Must deposit
  before performing actions"). One-click therefore has the user SIGN the agent approval at setup (`hub.signAgentApproval`) and
  submits it after the first bridge-in lands. HyperCore accepts a signed action ~2 days after its nonce; re-sign if older.
- HyperCore has two USDC balances: perps (`""` dex) and spot (`"spot"`). **Spot AND HIP-4 outcomes spend the spot balance.**
  The relayer credits perps; the app's **agent** can move the user's own USDC between them with `agentSendAsset`
  (destination must be the same account; no main-key signature). The hub does this automatically (`placeOrder(..., {fundFrom})`).
- Spot buy fees are taken in the bought token (19 PURR bought → 18.9867 held); selling "everything" leaves sub-lot dust (szDecimals).
- Most browser wallets (MetaMask etc.) currently only allow 7702 delegation to their OWN delegator contract. Our setup works with
  embedded wallets / wallets that allow custom delegation; for MetaMask the route is ERC-7715 permissions via its delegation
  toolkit. **Checked 2026-09-25:** Rabby, Coinbase Wallet, Phantom, MetaMask all refuse custom 7702 delegates; MetaMask ERC-7715
  isn't enabled on Elysium (not in its supported networks; its DelegationManager isn't deployed here); **Phantom can't add
  custom networks at all** (can't transact on Elysium). → **DECIDED: Privy embedded "Neuriio wallet"** (next bullet).
- **Wallet strategy (decided + verified 2026-09-25):** sign up with **X (Twitter) or any external wallet** via Privy; Privy
  creates an embedded wallet for every user (`createOnLogin: "all-users"`), which delegates to `NeuriioAccount` with
  `useSign7702Authorization` and signs silently (`showWalletUIs: false`). First-time user signs **1 thing: the deposit** from
  their own wallet (X users deposit from an exchange/anywhere). No new contract (a `NeuriioRouter` allowance design was
  considered and dropped). Keys like Hyperliquid's own app: random device + agent keys in browser storage (HL's app:
  `crypto.getRandomValues`, `sessionStorage` unless "persist" → `localStorage`, key `hyperliquid_agent_<addr>`).
  X login uses **Privy's shared X app for now** (consent screen says "Privy"); later: create an X app under the Neuriio X
  account (OAuth 2.0 Client ID/secret, callback `https://auth.privy.io/api/v1/oauth/callback`, Web App, Read) — dashboard-only
  change. Tradeoffs: Privy dependency/pricing; HL positions live under the Neuriio wallet's address.

## 8. For the UI

**Trade hub** (`keeper/src/trade/hub.mjs`, browser-safe, uses `@nktkas/hyperliquid` + viem):
```js
const hub = await new TradeHub({ testnet: true }).init();   // no builder fee (subscription)
hub.catalog.list("perp" | "spot" | "outcome")               // markets with live mid, maxLeverage, szDecimals
await hub.onboardingStatus(user)                             // { builderFeeRequired:false, agents:[...] }
const { key } = await hub.createAgent(mainWallet)            // ONE signature; store agent key on device only
hub.preview("HYPE", { side:"buy", usd:100, leverage:10 })    // size, price, notional, margin, fees -> confirm screen
await hub.placeOrder(agent, "HYPE", { side, usd|size, leverage, type:"market"|"limit", limitPx, takeProfit, stopLoss })
await hub.closePosition(agent, user, "HYPE"); await hub.cancel(agent, "HYPE", oid)
await hub.portfolio(user)   // perps (entry, mark, uPnL, ROE%, liq, funding), spot, outcomes (shares, value, payoutIfWins)
```
**One-click** (`keeper/src/oneclick/`, browser-safe; this is what the one-button UI calls):
```js
// setup (once): the two approvals, no gas
const { deviceKey, request } = await prepareSetup({ main, pub, delegate, caps: { maxPerBuy, maxPerDay, validDays } }); // 7702 auth + AddSession sig
await new SponsorClient(url).setup(request);                     // store deviceKey on the device only
const agentInfo = await hub.signAgentApproval(main);             // HL agent: signed now, submitted after 1st deposit
// the button
const oc = await new OneClick({ pub, hub, sponsor: new SponsorClient(url), bridge, inventory }).init();
const q = await oc.quote({ user, payToken, amountIn, market: "BTC", leverage: 3 });   // q.est.amount / q.est.symbol = "est." on the button; q.ok false -> q.error (e.g. < $10)
await oc.buy({ user, device, agent, agentApproval: agentInfo.approval, payToken, amountIn, market, leverage,
               onStage: (s, info) => ... })   // stages: quoting -> sending -> bridging -> ordering -> done  (drive the loading animation)
```
Live timings: click → filled **~10–13 s** before the 2026-09-25 speed fixes (quote reuse via `buy({ quote })`, credit spotted on
HyperCore instead of waiting for Elysium `markFulfilled`, agent approval + leverage done while bridging for existing accounts,
sponsor kicks the relayer on 127.0.0.1:8790): **re-timed 9.3–9.4 s** (sending ~3–4 s, bridging ~3–4 s, ordering ~2 s).
**Fast path built + verified 2026-09-25:** `oc.quoteFromHl` / `oc.buyFromHl` pay from USDC already on HyperCore: 3x BTC
filled in **2.9 s** (no bridge, sponsor, Elysium tx or gas). Session caps do NOT apply there (enforced on Elysium only);
same model as Hyperliquid's own app (agent trades, can't withdraw). Quote fields: `usdc`, `fees.bridgeUsd`,
`fees.hyperliquidActivationUsd` (exact, via HL `preTransferCheck`), `fees.tradeUsd`, `orderUsd`. Errors to surface:
"market paused" (stale oracle after one retry), cap errors (`OverPerBuyCap`/`OverDailyCap`), deposit timeout → refund after 1 h.

**On-chain (Elysium):**
- Swap: `PropAMM.previewBuyBase/previewSellBase` → `buyBase(quoteIn, minOut, to, deadline)` / `sellBase(...)`; `currentQuote()` for live bid/ask.
- Bridge in (any supported token): `FastBridge.deposit(token, amountIn, minUsdcOut, hlRecipient, deadline)`; watch `DepositFulfilled(id)` (~3–6 s). Show "Refund available" if still pending after 1 h (`refund(id)`).
- Bridge out: user `usdSend`s to the inventory account on HL; watch `PaidOut(hlRef, to, amount, fee)` (~4–5 s).
- Events for live feeds / gamification: `PropAMM.Swap` (price, Core mid, reserves), `FastBridge.DepositRequested/DepositFulfilled/PaidOut`.

**UI direction (user, 2026-09-25): "one-button buy", NOT a swap modal. For now this is the ONLY UI feature to build.**
- No "token in → token out" swap box. If a user holds $KNTQ on Elysium and wants SPCX (a HyperCore spot token), they should
  **not** see "deposit KNTQ, receive SPCX". They see a **button labeled "SPCX"** and the amount they'll buy.
- Same pattern for **perps, spot, and outcomes** on HyperCore: pick the market → button → **"est." amount** they'd get →
  click **Buy** → **loading animation** → result displayed ("boom").
- As they type different amounts of whatever they're paying with, the est. quote updates live (to design together: how the
  quoting displays). Under the hood it's still pool swap → FastBridge → HL order; the UI hides all of that.
- **One-click is BUILT (2026-09-25):** two one-time setup approvals (7702 delegation + session key in one flow; HL agent
  approval), then zero prompts and zero gas per buy. Design as built: EIP-7702 delegate `NeuriioAccount` (no `BuyRouter`, no
  per-token approvals), device session key (HL recipient hard-locked to the wallet itself, per-buy + daily USDC caps, expiry,
  revoke one/all), our gas sponsor, agent-side perps↔spot USDC moves (so no relayer `spotSend` change was needed).
- **More EIP-7702 smart-account uses to build on (user wants these, 2026-09-25):**
  - *Pay gas in any token:* users holding only KNTQ never need HYPE for gas (big onboarding win).
  - *Multi-step in one click:* swap + bridge + deposit in one tx; one-click "rebalance my portfolio".
  - *Set-once automations* via capped keys, no user online: take-profit/stop-loss sweeps, recurring buys ("$50 SPCX weekly"),
    auto-withdraw profits.
  - *Subscription billing:* capped recurring pull permission ("Neuriio may take $X per 30 days") → ties into TODO 2 gating.
  - *Recovery/security:* spending limits, guardian/social recovery, "freeze account" from a second device, same address.
  - *Gamified UI rewards:* we sponsor gas → free actions, streak rewards, claimable rewards with no gas friction.
  - *Sign-in:* one wallet signature = a session; app feels like a normal app with no pop-ups.
  - **Risk:** the delegate contract controls the user's *whole wallet*, not just app funds; phishing to malicious delegates
    is a known attack. Keep it minimal, non-upgradeable (or tightly limited upgrades), and make it the **#1 priority in the
    security audit (TODO 6)**.
- **Standards (EIPs/ERCs) — use these instead of inventing our own:**
  - *Used today:* **ERC-20** (pool, FastBridge, mock tokens); **EIP-712** (indirectly, via the HL SDK for every HL signature).
  - *Planned:* **ERC-4626** (later vault for outside capital); **EIP-7702** (one-click smart account, core design);
    **EIP-2612** permit (only in the non-7702 fallback).
  - *Adopt with 7702:* **ERC-5792** `wallet_sendCalls` (batching from wallets); **ERC-7715** `wallet_grantPermissions`
    (standard session-key permission request → our device key); **ERC-7579** modular accounts (reuse audited session-key /
    spending-limit / recovery modules instead of custom code → lower audit risk); **ERC-1271** (signature checks for smart
    accounts); **ERC-4337** paymaster (sponsored gas, gas in any token).
- Open questions for when the user is back: what the pay-with picker looks like, how est. is computed across legs
  (pool preview + HL `hub.preview`), what shows during each leg of the loading animation, failure/refund states.

**UX rules learned in testing:**
- One-click: a brand-new user's first buy also submits their HL agent approval (can't be done before the first deposit).
- Retry a swap/deposit once if it reverts `StaleByTime` (the oracle is a few seconds behind). Always pass `minOut` from a fresh preview.
- Disclose Hyperliquid's $1 first-transfer fee on a user's first bridge-in.
- Build readable outcome names from `description`; show "—" when `liquidationPx` is null.
- The app works only while the bots run. Show a "market paused" state when quotes revert.

## 9. TODO (prioritized)

1. **UI** (next; user brings branding/logo/design). Only feature for now: the **one-button buy** (see §8 "UI direction"),
   no plain swap modal. Backend for it is DONE (`keeper/src/oneclick/`). Wallet DECIDED + verified (Privy, §7). Open: a sponsor
   keystore + hosting; real deposit flow (external wallet → Neuriio wallet); "pay from HL balance" fast path.
2. **Subscription gating + DEX aggregator partnerships:** subscription contract (flat monthly rate, later tiered from a month of data) + pool/bridge check that only subscribers can trade. Also stops abusive bots, which matters more at a 5 bps spread (price lag ~2 s).
   **Goal: partner with DEX aggregators on Elysium** (being first with a HyperCore-priced PropAMM = best prices ready to route).
   Our own users don't need an aggregator (pool already quotes HyperCore ± 5 bps); aggregators bring other apps' flow.
   Design issue: a router is `msg.sender`, so a subscriber check can't see the end user → decide per-router terms (e.g. allowlisted
   routers at a wider edge, or free as a growth channel). **Also gate the gas sponsor to subscribers** (today it only has
   per-wallet rate limits + a $10 minimum buy, which don't stop someone spinning up many wallets). Contract work: router allowlist with its own edge, optional exact-output
   buy, a short integration doc (aggregators write an adapter per pool). One pool per pair; each token needs an HL market to hedge on.
3. **Real hedging on mainnet** (hedger `live` mode with an HL API agent key), real USDC/wHYPE token addresses on Elysium (HYPE is native gas → needs a wrapped HYPE ERC-20), mainnet deploy.
4. **Ops:** run bots on a server (not a laptop), secure signer for the relayer's hot HL key (keep a working balance only), automated inventory rebalancing, alerting, Conduit API key.
5. **Small fixes:** Step 3 `planner.roundPx` rounds prices < $1 one decimal coarse (fixed in trade code, not in hedger); `DEPTH_BPS` should track the hedger's slippage setting.
5b. **When Elysium precompiles ship (~4 weeks after mainnet):** re-check docs for the ABI, then (a) native read-precompile oracle
   adapter behind `IHyperCoreOracle` (retires the feeder), (b) move hedging on-chain via `ElysiumCoreWriter` (retires the hedger bot).
6. **Security audit (AI, public):** before bringing on a professional audit team, run a full security audit
   with the **highest Claude model available at that time** (Fable 5.1 as of now). Deliverables are **open-source
   documents published in the project docs**, written so a professional audit team can start from them:
   - `docs/ARCHITECTURE.md`: every component (contracts, bots, relayer, trade hub), how money and trust flow,
     roles and keys, off-chain assumptions, and the trust model.
   - `docs/SECURITY_AUDIT.md`: exact **scope** (files, commit hash, deployed addresses), **methodology** (review
     passes: attacker mindset, accounting invariants, access control, oracle/staleness, bridge/relayer and key
     handling, upgrade/admin risk), **threat model**, and **every finding** with severity, a reproducing test,
     and its fix status.
   - Plus Foundry invariant fuzzing and static analysis (Slither, Aderyn) results attached.
   **Top priority in scope: the EIP-7702 delegate contract** `src/account/NeuriioAccount.sol` (controls users' whole
   wallets; see §8), then the sponsor service (holds a hot gas key, decides what to submit).
   The AI audit is a layer, not a replacement: follow it with a professional audit + bug bounty, and launch with low caps.
   **Pro audit budget estimate (2026-09-25, market rough ranges, get 3–4 real quotes):** ~820 nSLOC ≈ 1–2 weeks × 2 auditors.
   Top-tier firm $40k–$90k (1–3 month queue); mid-tier $15k–$40k; strong solo $6k–$15k; contest pool $20k–$50k.
   Up: EIP-7702 delegate (novel, whole-wallet risk), oracle/bridge logic, off-chain relayer/sponsor (+30–60% if in scope, or a
   separate backend review). Down: small codebase on OpenZeppelin, good tests, our ARCHITECTURE/SECURITY_AUDIT docs.
   Recommended: AI audit → one mid-tier firm or top solo (~$15k–$40k) → contest/bug bounty before raising caps (~$30k–$70k total).
6a. **"Fast exit" for all of Elysium (idea, 2026-09-25):** nobody has one (official bridge page lists only the native rollup
   bridge). Generalize FastBridge: user sends a token on Elysium, our relayer pays the SAME token on HyperEVM or HyperCore
   from inventory in seconds; we refill via the ~25 min native withdrawal and charge a small fee (Across/Relay model).
   Inventory: HyperCore spot + HyperEVM ERC-20s + Elysium (fills with exits, pays re-entries). Pitch to Kinetiq + grant
   material. Also ask Kinetiq: more frequent checkpoints (the real delay), and whether mainnet will use fast confirmation.
   Context: every fast bridge skips the challenge window one of two ways: **liquidity** (Across/Relay/deBridge: MM fronts
   funds; any token; needs inventory) or **messaging** (LayerZero/Hyperlane/Wormhole/CCTP: burn + mint on an off-chain
   verifier attestation; no inventory, per-token opt-in, trust the verifiers). Hyperlane is permissionless to deploy, so a
   token issuer (e.g. KNTQ) could run Elysium↔HyperEVM warp routes in seconds. Elysium validation is permissioned at launch
   (rollup allowlist on, 0.1 HYPE stake) → BoLD later; only then could we post checkpoints ourselves.
6b. **Pitch deck (user asked 2026-09-25: start it next handoff):** for a raise and/or the Elysium builder grant. Launch capital
   is needed for: pool reserves on Elysium (both sides), hedge margin on HyperCore, bridge inventory (USDC on HyperCore +
   on Elysium). Content: what's built + testnet-verified (timings: bridged buy 9.3 s, HL-balance buy 2.9 s, zero-pop-up
   Privy setup), architecture, security/audit plan (TODO 6), funding ask. Levers that cut capital: ERC-4626 LP vault,
   start with one pool at low caps, and a **USDC-only launch** (FastBridge needs no pool for USDC, only bridge inventory)
   so subscriptions can start before the PropAMM is funded.
7. **Before mainnet:** professional audit, legal/jurisdiction review (leveraged perps + prediction markets), confirm HL fees at scale, contract minEdge granularity (whole bps; 4.5 needs a contract change).

## 10. Next session (2026-09-29): the EXPLORE page

### Where we are (sessions 2026-09-27/28, summary)
- **Backend (done, testnet):** pump.fun-style launchpad replaced the paused PropAMM (§0). One token per X account named
  `@handle` / ticker `HANDLE`, signed launch passes from Supabase `launch-pass`, 6 categories, creator profile (about + links)
  hashed on-chain. Fees: 0.75% curve, 0.25% pool, all into `FeeVault` → 80% creator (claim) / 20% protocol (60% community,
  40% KNTQ buyback, manual; **wallet addresses still to come from the user**). Graduation at pump.fun shape (testnet tiny:
  ~1.37 HYPE mcap; mainnet 60 HYPE virtual ≈ 822 HYPE mcap), LP burned. Current addresses: §0 "CURRENT testnet set".
- **Supabase (done):** users / creator_profiles / tokens / trades / points_ledger / leaderboard; `register`, `launch-pass`,
  `indexer` (pg_cron every minute: launches, curve trades, graduations, router `Swapped`, pair swaps, HL builder fills).
  Points: 100/\$1M launched-token volume, 75/\$1M HL via Neuriio, 50 for launching. Tables are public-read (not `users`).
- **Launch UI (DONE, user approved 2026-09-28)** at `app.neuriio.xyz/launch` (`app/src/components/LaunchCard.tsx`,
  `app/src/lib/launch.ts`, styles `.li-*` / `.lp-*` in `app/src/app.css`):
  1. Intro card **750 × 350**: solid `#1b1428`, lavender tint + 20px dot grid coming in from the right (reference-card look),
     14 twinkling grid dots, the launchpad's bonding curve rising from the bottom-left with a glowing dot climbing it.
     Only text: "THE FUTURE FOR CREATORS" (20px, cyan `--cyan-2`, semibold, uppercase, 0.22em) + one button in the top
     Account/Points card style (104 × 38): **Login** (logged out) → after login it becomes **Launch** (no auto-advance).
  2. Launch → label + button blur out, the FTF line reveals word by word in the same style at **14px**: "The platform to grow
     your brand or combine yourself with friends to form a FTF (Friends Turned Fam) where you and 3 others create a group
     ticker." → **Next** bottom-right.
  3. Flow card **1000 × 512** (same background): left preview (pfp, @handle, $HANDLE, category chip, curve chart, supply /
     graduation mcap / 0.75% fee, "No promise of value."); right 3 steps: Who you are (6 tiles) → Profile (about 50–5,000
     + links) → Launch (optional first buy, estimate, checkbox "I understand @handle has no promise of value or promise any
     returns to anyone.") → staged progress → "@handle is live" + Share on X.
  - Already launched → straight to the live screen. `?demo` (logged in) / `?demo=out` (logged out) preview with fake data.
  - **Verified with a real X login** (user, Firefox): @von_hl launched end to end on the previous launchpad (then reset:
    new launchpad deployed, old Supabase token/trade/point rows cleared, `users` row kept).
  - Known nit (user undecided): at 14px the FTF line's first line touches the rising curve on the right; options: narrow the
    text to 4 lines or move the curve's steep part right.
  - Browser pane pauses animations while hidden: screenshots can look half-faded; the app is fine (check in Firefox).
  - Dev server: `npm --prefix app run dev` now binds **127.0.0.1:5173** (vite.config.js) — "localhost" was IPv6-only before.

### Next: the Explore page (user's plan, 2026-09-28)
After a successful launch the app goes to **Explore** (route e.g. `/explore`, same shell: header, marquee, Account/Points,
footer; content in the center "modals", as many per page as needed — user designs the look together, one element at a time,
per memory "UI pacing"). Contents the user described:
- **A chart with all the details** for a token (price over time + stats: market cap, volume, holders?, curve progress to
  graduation, creator profile/about/links, category, creator earnings from `FeeVault.creatorEarned`).
- **Above it: a search for handles** and a **Top 25 handles ranked by volume** (etc. — other rankings to decide).
- Right after a launch, land on the new token's Explore view.
Data to build for it (Supabase, public-read):
- `token_stats` view: per token 24h / all-time USD volume (from `trades`, venues curve + pool), trade count, last price,
  mcap (price × 1B), curve progress (tokens sold / 793.1M, from the latest `Trade` event's virtual reserves or an on-chain
  read), graduated flag, creator handle/pfp (join `users` via `x_user_id`), category.
- Price history for the chart: from `trades` (price = quote_amount / size per trade) → candles/line by time bucket (SQL
  view or RPC). Consider storing the Trade event's `virtualHype/virtualToken` (curve spot price) in the indexer.
- Handle search: `tokens.handle ilike` (+ `users.x_handle`); top 25 by volume from `token_stats`.
- Possibly index `FeeVault.FeeCredited` (creator earnings) and holders (ERC-20 Transfer logs) if the page shows them.
- Open questions for the user: chart style (line vs candles, time ranges), which stats, ranking tabs (volume / newest /
  near graduation / top gainers), whether Explore also lists tokens without a search, and buy/sell from Explore.

### Elysium mainnet timing + HyperCore graduation (checked docs 2026-09-28, pages "last updated" Sep 21–22)
- **No mainnet date or target anywhere in the docs.** Elysium is "pre-launch"; mainnet chain ID / RPC / explorer are "Coming
  soon" (published at launch). Only relative timing: launch (stock ArbOS, HYPE gas, AnyTrust DA, HyperEVM settlement, all
  token bridges) → **~4 weeks after mainnet** an ArbOS upgrade adds the HyperCore read precompile + keeper fast-write lane →
  hardening (MEV/Timeboost, ~100 ms blocks, BoLD, audits). For a date: contact the Kinetiq team (docs invite integration /
  early-access questions) — worth doing, since we launch alongside them.
- **Docs describe our exact lifecycle:** "launch on an Elysium AMM → deepen on prop-AMM markets → graduate to a HyperCore spot
  orderbook → perp listing via HIP-3". Path: Elysium token → **mirror bridge** (lock on Elysium, 1:1 mirror on HyperEVM;
  permissionless, one-time 2-tx setup; needs immutable name/symbol/decimals, no fee-on-transfer — our LaunchToken fits)
  → HyperCore via a **deposit wallet** after the issuer's **spot deployment ceremony**: win the ticker in HL's Dutch auction
  (~31 h cycles; price read live, can be expensive), deposit wallet, one-shot genesis (full supply at the system address),
  link (permanent), list (registerSpot; bridged tokens have Hyperliquidity disabled → empty book unless someone makes markets).
  Takes days. **HyperCore tickers are max 6 characters** (most @handles won't fit).
- **User asked: drop our own pool and route to "their" pool, still getting fees?** Answer given: Kinetiq has no pool of its own
  (bridges only). Trading fees on HyperCore spot go to Hyperliquid; we'd earn only our builder fee (spot up to 1%) on orders
  placed through our app, not other front ends, so creator 80% couldn't be guaranteed on all volume. **Recommendation: keep
  our pool** as the graduation target for every token (fees enforced on-chain); add an optional later "graduate to HyperCore"
  tier for big tokens (costly per-token ceremony; fees there only via builder code). To verify before designing it: whether
  HL lets a spot deployer take a share of trading fees, current ticker-auction prices, and who pays/owns the deployer key.

### "Their pool": Elysium AMMs + fees (researched 2026-09-28)
- **Docs:** Kinetiq runs NO pool/DEX; AMMs are left to builders ("launch on an Elysium AMM", "prop-AMM markets", market-making
  AMMs as flagship tenants). Fee facts only: gas in HYPE, low by design (quote refresh 5–10×/s cheap), neutral priority-fee
  ordering (no privileged lanes). **"A builders allocation of sequencer revenue is reserved for ecosystem incentive programs
  for applications building on the chain"** → apply (grant / revenue share for us).
- **On-chain scan, Elysium testnet blocks 0–558,353** (PairCreated / PoolCreated / V4 Initialize topics), third-party only:
  - UniV2 fork `0xb2f8ad730e9d05d333c7861184aad0bff1785dd0` (21 pairs, feeToSetter `0xf889…3e36`, feeTo OFF → all 0.30% to LPs)
  - UniV2 fork `0x16e2a1b953b2e1fc2a82f8e2d68a13884e18a2b9` (15 pairs, feeToSetter `0xe2d0…3D79`, feeTo OFF)
  - UniV3 forks: factory `0x77573e627213afcfb5c2165940ce696fef2b4794` (owner `0xf023…69f3`, 1% tier) + 4 lone pools (1% / 0.05%)
  - **UniV4 PoolManager `0x889a96eedb1df35a012d7e48baf7f9c780f1243b` (owner `0xf889…3e36`) + launchpad hook
    `0xda605da70bff4b32a9b379c614a6d9e4a09baaec`** (17 KB, deployed block 97,383 by `0xf88929028c0D0932C6C6faFe77267f94C97d3e36`
    via the CREATE2 factory): 3 tokens (V4CANARY, KOALA, SENDIT) vs WHYPE (`0xcd57…f234`), pool LP fee 0, fees charged by
    the hook (terms show 3000 = 0.30%), held in the hook, `distribute()` → `protocolRecipient` `0x1110…1bdf` (+ likely
    creator); anti-manipulation: EMA_WINDOW 600 s, FLOOR_WIDTH 2000, MAX_DEV 1000. **Direct competitor; identity unknown**
    (Kinetiq test DEX or an early ecosystem team).
  - Our factories: `0x37fb…418f`, `0x1e9b…e45a`, `0x9ea7…a056`, current `0xa6ec…b08a`; `0xfa45…b3f9` (1 pair, fee setter 0) unknown.
- **Answer to the user:** routing our tokens to their pools earns us/creators nothing from the pool (their hook pays its own
  recipients); only a router-level fee on trades placed from our app or an integrator share if one exists. **Keep our pool.**
- **Ask Kinetiq (one message):** mainnet date; who runs the V4 launchpad (`0xf889…`); builder incentive program terms + how to
  apply; whether any Elysium AMM offers an integrator/referral fee share.
- Idea (user): fund each token's later HyperCore spot deployment from its pool fees (per-token "HyperCore fund" in FeeVault,
  released at a milestone). Open: which share funds it (creator 80 / protocol 20 / new split) and who holds the ticker key.

### Also open (not tomorrow unless asked)
- User to send **community + buyback wallet addresses** → `FeeVault.setWallets` (owner = burner).
- Creator **claim** button in the UI (FeeVault `claim`), `register` call after login (points for non-launchers),
  builder fee wired into the future buy UI (`HL_BUILDER`), holding-points math (TBD by user).
- Burner ~0.30 testnet HYPE: top up before the next full live test (`./script/launchpad-test.sh burner`, needs 0.35).
- FTF (Friends Turned Fam) contracts: LATER (§0).
- Older queue: pitch deck (TODO 6b), fast-exit bridge idea (TODO 6a), sponsor hosting, PropAMM paused until capital.

## 11. Repository

- **GitHub:** https://github.com/finding-agi/Neuriio. **PRIVATE.** Branch `main`, tracking `origin/main`.
- **One-click commit:** all 2026-09-25 work (NeuriioAccount, oneclick/, sponsor, scripts, tests, HANDOFF) committed + pushed to `main`.
- **UI + KNTQ pool commit (2026-09-27):** the `app/` UI so far, the tKNTQ pool scripts + deploy records, HANDOFF, pushed to `main`.
- **First commit:** `7210a75` "Initial commit: Elysium trade hub (Steps 1-5, testnet-verified)", 64 files, pushed 2026-09-24.
- **GitHub CLI:** active account `finding-agi` (`holdfebu` also logged in; switch with `gh auth switch`).
  Commits are authored as `von <von@hlos.org>`.
- **Before making it public** (planned alongside the open-source architecture/audit docs): re-scan history for
  secrets. At the first commit the only key-like strings were the two public anvil test keys in `script/e2e-bridge.sh`.
  The burner key lives in `~/.foundry/keystores`, never in the repo. `logs/`, `cache/`, `.env` and `node_modules/` are gitignored;
  `docs/` is intentionally **not** ignored (the audit docs go there).
