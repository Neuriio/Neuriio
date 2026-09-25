# Handoff — Elysium trade hub (state as of 2026-09-24)

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

## 2. How it fits together

```
User on Elysium
  ├─ Swap HYPE<->USDC ............ PropAMM pool (priced off HyperCore, hedged on HL perps)
  └─ "Open 10x HYPE with my KNTQ"  FastBridge.deposit(token)
        -> pool converts to USDC -> relayer instantly credits the user's OWN HL account from our HL inventory
        -> trade hub places the order on HL (signed by the user's trade-only app key)
  └─ Withdraw ..................... user usdSends to our HL inventory account -> relayer pays out on Elysium
```

Bots (off-chain, `keeper/`): **feeder** (HyperCore prices → oracle), **hedger** (keeps HL perp short = pool's HYPE),
**relayer** (runs the bridge). The bridge never moves tokens across chains; it pays out of our own inventory on
each side ("a cash drawer in both countries") and we rebalance slowly.

## 3. Roadmap status

| Step | What | Status |
|---|---|---|
| 1 | HyperCore price oracle (`KeeperHyperCoreOracle` + `HyperCoreReader`) | ✅ live on testnet |
| 2 | PropAMM pool | ✅ live on testnet |
| 3 | Hedger | ✅ runs **simulated** on testnet (pool is priced off *mainnet* HYPE; testnet HYPE is a different market) |
| 4 | FastBridge + relayer | ✅ live on testnet, real HL testnet USDC, round trips verified |
| 5 | Trade hub backend (`keeper/src/trade/`) | ✅ real fills verified on HL testnet |
| 6 | **UI** | **next — user is building it** (goal: interactive/gamified, not a standard DeFi UI) |
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

- **Owner of everything + every operator role:** user's Foundry keystore account **`burner`** = `0xef584b1098e12c34d1d85de76285c408ab6917a8` (~0.95 HYPE gas left).
- **Treasury wallet** (funds the HL inventory; its transfers are top-ups, not withdrawals): `0xe973105a27e17350500926ae664dfcfe6006d924`.
- **Live settings:** pool edge 5 bps, minEdge 5, skew 0, impact 0, maxTrade 10% of pool, depth factor 2×, maxAge 5 s. Oracle clock slack 2.5 s. Bridge fee 0, refund delay 1 h, caps $25k/tx and $100k/day.
- **State at handoff:** pool 103.93 tHYPE + 8,937.09 tUSDC; bridge credit 684.25, free liquidity 214.75 tUSDC; burner HL testnet inventory 784.25 USDC.
- **Bots are STOPPED.** The pool refuses quotes (stale price) until the feeder runs again.

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
./script/deploy-testnet.sh burner   # fresh deploy of oracle + tokens + pool + bridge
forge test                          # 61 passing (+ fork suite: forge test --match-path 'test/fork/*' --fork-url elysium_testnet)
cd keeper && npm test               # 42 passing
./script/e2e-bridge.sh              # full local e2e on anvil (no keys needed)
```

Bot logs: `logs/*.log` (each bot prints `rpc_stats` every minute). Relayer state: `logs/relayer-state.json`.
Scripts auto-retry nonce clashes (the feeder signs with the same account), and only one set of bots should run at a time.

## 6. Repo map

```
src/interfaces/IHyperCoreOracle.sol   stable oracle interface (swap to Elysium's native precompile later)
src/oracle/KeeperHyperCoreOracle.sol  keeper-pushed prices (bid/ask, sizes within 20 bps, Core time)
src/libraries/HyperCoreReader.sol     freshness / spread guards      ElysiumBlock.sol  L2 block via ArbSys
src/amm/PropAMM.sol                   pool: ask=coreAsk*(1+edge..), bid=coreBid*(1-edge..), no-arb clamp
src/bridge/FastBridge.sol             deposit/markFulfilled/refund, payout, compare-and-set credit
keeper/feed-bbo.mjs  hedger.mjs  relayer.mjs     bot entry points
keeper/src/rpc.mjs                    shared transport: fallback RPC, batching, backoff, req/min stats
keeper/src/planner.mjs hedger.mjs exchange/     hedging engine (sim + live HL adapter)
keeper/src/bridge/                    relayer logic, chain adapter, HL transfers (live + sim)
keeper/src/trade/                     TRADE HUB — what the UI calls (see §8)
keeper/test/live/                     live scripts used by script/*-test.sh
```

## 7. Hard-won facts (don't rediscover these)

- Elysium's HyperCore read precompile and `ElysiumCoreWriter` are **not live** (ship ~4 weeks after mainnet). No atomicity between Elysium and HyperCore.
- On Elysium, Solidity `block.number` = **HyperEVM's** height; use ArbSys (`ElysiumBlock.number()`). `block.timestamp` is 1 s resolution and trails real time by ~1–2 s. Blocks only happen when there are txs.
- Foundry forks don't execute Nitro precompiles (ArbSys is a `0xfe` stub) and don't emulate the `block.number` behavior.
- Public RPC rate-limits: bots now use ~155 req/min total with fallback to `https://elysium-testnet-rpc.hypedexer.com/`. viem's `writeContract` silently adds several `eth_fillTransaction` calls. Sign locally + `sendRawTransaction`. Always read with `getBlockNumber({ cacheTime: 0 })` for money decisions.
- HyperCore quirks: `usdSend` needs the **main** key (agents can't move funds); first send to a new account costs **$1**; the `fee` field on fills *includes* builder fees; SDK **throws** on order error statuses (hub handles it); outcome markets use asset id `100000000 + 10*outcome + side`, mids `#N`, balances `+N`, size decimals 5, raw names like `template:priceTouch`.
- HL testnet: **HYPE perp book is one-sided/empty** (test perps with BTC); HL testnet faucet needs mainnet history (user funded the burner from their main wallet).
- Deposits near the 1 h refund window are never sent by the relayer (user may be refunding). Inventory top-ups must come from a `TOPUP_FROM` wallet or they look like withdrawals.
- ~$211 of testnet USDC is stranded in two throwaway accounts from early runs (keys gone). Harmless; tests now always withdraw everything.

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
**On-chain (Elysium):**
- Swap: `PropAMM.previewBuyBase/previewSellBase` → `buyBase(quoteIn, minOut, to, deadline)` / `sellBase(...)`; `currentQuote()` for live bid/ask.
- Bridge in (any supported token): `FastBridge.deposit(token, amountIn, minUsdcOut, hlRecipient, deadline)`; watch `DepositFulfilled(id)` (~3–6 s). Show "Refund available" if still pending after 1 h (`refund(id)`).
- Bridge out: user `usdSend`s to the inventory account on HL; watch `PaidOut(hlRef, to, amount, fee)` (~4–5 s).
- Events for live feeds / gamification: `PropAMM.Swap` (price, Core mid, reserves), `FastBridge.DepositRequested/DepositFulfilled/PaidOut`.

**UX rules learned in testing:**
- Retry a swap/deposit once if it reverts `StaleByTime` (the oracle is a few seconds behind). Always pass `minOut` from a fresh preview.
- Disclose Hyperliquid's $1 first-transfer fee on a user's first bridge-in.
- Build readable outcome names from `description`; show "—" when `liquidationPx` is null.
- The app works only while the bots run. Show a "market paused" state when quotes revert.

## 9. TODO (prioritized)

1. **UI** (user, in progress).
2. **Subscription gating:** subscription contract (flat monthly rate, later tiered from a month of data) + pool/bridge check that only subscribers can trade. Also stops abusive bots, which matters more at a 5 bps spread (price lag ~2 s).
3. **Real hedging on mainnet** (hedger `live` mode with an HL API agent key), real USDC/wHYPE token addresses on Elysium (HYPE is native gas → needs a wrapped HYPE ERC-20), mainnet deploy.
4. **Ops:** run bots on a server (not a laptop), secure signer for the relayer's hot HL key (keep a working balance only), automated inventory rebalancing, alerting, Conduit API key.
5. **Small fixes:** Step 3 `planner.roundPx` rounds prices < $1 one decimal coarse (fixed in trade code, not in hedger); `DEPTH_BPS` should track the hedger's slippage setting; native Elysium precompile oracle adapter when it ships.
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
   The AI audit is a layer, not a replacement: follow it with a professional audit + bug bounty, and launch with low caps.
7. **Before mainnet:** professional audit, legal/jurisdiction review (leveraged perps + prediction markets), confirm HL fees at scale, contract minEdge granularity (whole bps; 4.5 needs a contract change).

## 10. Repository

- **GitHub:** https://github.com/finding-agi/Neuriio. **PRIVATE.** Branch `main`, tracking `origin/main`.
- **First commit:** `7210a75` "Initial commit: Elysium trade hub (Steps 1-5, testnet-verified)", 64 files, pushed 2026-09-24.
- **GitHub CLI:** active account `finding-agi` (`holdfebu` also logged in; switch with `gh auth switch`).
  Commits are authored as `von <von@hlos.org>`.
- **Before making it public** (planned alongside the open-source architecture/audit docs): re-scan history for
  secrets. At the first commit the only key-like strings were the two public anvil test keys in `script/e2e-bridge.sh`.
  The burner key lives in `~/.foundry/keystores`, never in the repo. `logs/`, `cache/`, `.env` and `node_modules/` are gitignored;
  `docs/` is intentionally **not** ignored (the audit docs go there).
