# Handoff — Elysium trade hub (state as of 2026-09-25)

Read this first in a new session. `README.md` has per-step detail; this file is the current truth.

**Project name: Neuriio.** Local folder `/Users/von/Neuriio` (renamed from `elysium`); code lives in the
**private** GitHub repo **https://github.com/finding-agi/Neuriio** (renamed from `finding-agi/elysium`; old URL redirects).

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
| 6 | **UI** | **next** — user brings branding/logo/design; only feature for now = one-button buy (§8) |
| 7 | **Security audit (AI, highest model) → public `docs/ARCHITECTURE.md` + `docs/SECURITY_AUDIT.md`** for the pro audit team | planned (see TODO 6) |
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

- **Owner of everything + every operator role:** user's Foundry keystore account **`burner`** = `0xef584b1098e12c34d1d85de76285c408ab6917a8` (~0.91 HYPE gas left).
- **Treasury wallet** (funds the HL inventory; its transfers are top-ups, not withdrawals): `0xe973105a27e17350500926ae664dfcfe6006d924`.
- **Live settings:** pool edge 5 bps, minEdge 5, skew 0, impact 0, maxTrade 10% of pool, depth factor 2×, maxAge 5 s. Oracle clock slack 2.5 s. Bridge fee 0, refund delay 1 h, caps $25k/tx and $100k/day.
- **State at handoff:** pool 106.43 tHYPE + 8,706.52 tUSDC; bridge credit 677.37, free liquidity 221.63 tUSDC; burner HL testnet inventory 777.37 USDC.
- **Bots are STOPPED** (user stopped them at the end of the 2026-09-25 session). The pool refuses quotes (stale price) until
  the feeder runs again. No sponsor service runs yet (needs its own keystore, see §5).

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
./script/deploy-oneclick.sh burner  # (re)deploy NeuriioAccount only (run with bots STOPPED: same key as the feeder)
./script/deploy-testnet.sh burner   # fresh deploy of oracle + tokens + pool + bridge + NeuriioAccount
SPONSOR_ACCOUNT=<keystore> TOPUP_FROM=... ./script/run-bots.sh burner   # also runs the gas sponsor on :8787 (SEPARATE keystore w/ a little HYPE)
forge test                          # 84 passing (+ fork suite: forge test --match-path 'test/fork/*' --fork-url elysium_testnet, 3)
cd keeper && npm test               # 52 passing
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
keeper/sponsor.mjs                    gas sponsor HTTP service (POST /setup, POST /buy, GET /health)
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
  toolkit. **Decide the wallet strategy with the UI.**

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
Live timings: click → filled **~10–13 s** (most of it is the bridge credit). Quote fields: `usdc`, `fees.bridgeUsd`,
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
   no plain swap modal. Backend for it is DONE (`keeper/src/oneclick/`). Open: wallet strategy (embedded wallet vs. ERC-7715
   for MetaMask-style wallets), a sponsor keystore + hosting, where device/agent keys live on the device.
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
7. **Before mainnet:** professional audit, legal/jurisdiction review (leveraged perps + prediction markets), confirm HL fees at scale, contract minEdge granularity (whole bps; 4.5 needs a contract change).

## 10. Next session: UI

Start here. User brings **branding, logo and design**. Build ONLY the one-button buy (§8 "UI direction") on top of
`keeper/src/oneclick/` + `TradeHub`. Decide first: wallet strategy (embedded wallet vs. ERC-7715 for MetaMask-style wallets),
where the device session key + HL agent key are stored on the device, and hosting for the sponsor service (needs its own
keystore with a little HYPE; `SPONSOR_ACCOUNT=... ./script/run-bots.sh burner`). The backend is ready: quote → live "est.",
`onStage` → loading animation, result → "boom". Bots must be running for anything to work (§5).

## 11. Repository

- **GitHub:** https://github.com/finding-agi/Neuriio. **PRIVATE.** Branch `main`, tracking `origin/main`.
- **One-click commit:** all 2026-09-25 work (NeuriioAccount, oneclick/, sponsor, scripts, tests, HANDOFF) committed + pushed to `main`.
- **First commit:** `7210a75` "Initial commit: Elysium trade hub (Steps 1-5, testnet-verified)", 64 files, pushed 2026-09-24.
- **GitHub CLI:** active account `finding-agi` (`holdfebu` also logged in; switch with `gh auth switch`).
  Commits are authored as `von <von@hlos.org>`.
- **Before making it public** (planned alongside the open-source architecture/audit docs): re-scan history for
  secrets. At the first commit the only key-like strings were the two public anvil test keys in `script/e2e-bridge.sh`.
  The burner key lives in `~/.foundry/keystores`, never in the repo. `logs/`, `cache/`, `.env` and `node_modules/` are gitignored;
  `docs/` is intentionally **not** ignored (the audit docs go there).
