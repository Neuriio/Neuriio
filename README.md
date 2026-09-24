# Elysium PropAMM

## Roadmap (model A: gateway trade hub)

| Step | Build | Status |
|---|---|---|
| 1 | HyperCore price oracle | ✅ |
| 2 | PropAMM pool (converts any HyperCore-priced token ↔ USDC) | ✅ |
| 3 | Hedging engine | ✅ (runs simulated on testnet; live HL mode built, not yet run for real) |
| 4 | Fast bridge: Elysium ↔ user's own HyperCore account, instant from our inventory | ✅ (verified live with real HL testnet USDC) |
| 5 | Trade hub backend: orders (perps, spot, HIP-4 outcomes), positions/PnL | ✅ (real fills verified on HL testnet) |
| 6 | Gamified UI: swap, trade, predict | next |
| 7 | Security audit by the highest Claude model available (Fable 5.1 today): open-source `docs/ARCHITECTURE.md` + `docs/SECURITY_AUDIT.md` (scope, methodology, threat model, findings) as the starting point for the professional audit team | planned |
| later | ERC-4626 vault for outside capital | |

We never take the other side of user trades. Revenue: **monthly subscription** — no spread profit (pool edge = hedge cost), no bridge fee, no builder fee. See `HANDOFF.md` for current state.
Launch caveats: collateral needs a HyperCore market; legal/jurisdiction review; bridge inventory caps throughput.

Arb-driven PropAMM on [Elysium](https://elysium.kinetiq.xyz/docs/what-is-elysium) (Arbitrum Orbit L2 settling to HyperEVM).

## Step 1 — HyperCore price reader ✅

| File | Role |
|---|---|
| `src/interfaces/IHyperCoreOracle.sol` | Stable interface every strategy depends on (WAD bid/ask/sizes + Core time/block + L2 block) |
| `src/oracle/KeeperHyperCoreOracle.sol` | Keeper-pushed adapter — works today. Swap for a native-precompile adapter when the ArbOS upgrade ships |
| `src/libraries/HyperCoreReader.sol` | Guarded read: no-data / crossed / stale-by-time / stale-by-L2-blocks / max-spread |
| `src/libraries/ElysiumBlock.sol` | L2 block height via ArbSys (`block.number` on Orbit is the *HyperEVM* block) |
| `keeper/feed-bbo.mjs` | Pulls HyperCore `l2Book` and pushes it on-chain |

```bash
forge test --no-match-path 'test/fork/*'                               # unit + fuzz
forge test --match-path 'test/fork/*' --fork-url elysium_testnet       # live testnet fork, no key needed
```

Deploy to Elysium testnet (chain 99801) and feed live data:

```bash
cast wallet import elysium-dev --interactive
forge script script/DeployOracle.s.sol --rpc-url elysium_testnet --broadcast --account elysium-dev
cd keeper && npm i
RPC_URL=https://testnet-rpc.elysium.kinetiq.xyz ORACLE=0x... PRIVATE_KEY=... MARKETS=1035 node feed-bbo.mjs --loop 1000
# HyperCore testnet books are thin; for realistic prices use HL_API=https://api.hyperliquid.xyz/info
# (mainnet spot indices differ, e.g. HYPE/USDC = 107)
```

## Step 2 — PropAMM pool ✅

`src/amm/PropAMM.sol` — single-pair pool priced off HyperCore top-of-book:

```
ask = coreAsk × (1 + edge − skew + impact)     bid = coreBid × (1 − edge − skew − impact)
clamp: ask ≥ coreBid × (1 + minEdge),  bid ≤ coreAsk × (1 − minEdge)   // no round-trip arb vs Core
```

- **Quoter** (keeper) updates `QuoteParams` (edge, inventory target, skew, impact) at high frequency; can pause.
- **Owner** (vault in step 4) sets `RiskParams` (min edge, max trade % of pool, max size vs Core depth, oracle freshness, max Core spread), manages liquidity, unpauses.
- Internal reserve accounting (donations can't move price); rejects fee-on-transfer tokens.
- `Swap` event carries price, Core mid, Core time and post-trade reserves — the feed for hedging (step 3) and the game UI (step 6).

```bash
# Testnet: mock tHYPE/tUSDC + oracle + seeded pool, priced off mainnet HyperCore (@107)
forge script script/DeployPropAMM.s.sol --rpc-url elysium_testnet --broadcast --account elysium-dev
HL_API=https://api.hyperliquid.xyz/info MARKETS=107 ... node keeper/feed-bbo.mjs --loop 1000
```

## Step 3 — Hedging engine ✅ (sim + read-only live; real orders pending your HL account)

`keeper/hedger.mjs` keeps a HyperCore **perp** position equal to `−(pool HYPE × hedgeRatio)`, so the system is price-neutral and earns only the spread.

| File | Role |
|---|---|
| `keeper/src/planner.mjs` | Pure math: target, lot/tick rounding (safe direction), $10 HL minimum, IOC limit with slippage cap |
| `keeper/src/hedger.mjs` | Reconcile loop (on every `Swap` + timer); never overlaps orders; pauses the pool if unhedged > `MAX_UNHEDGED_USD` for `GRACE_MS` |
| `keeper/src/exchange/hyperliquid.mjs` | Live HyperCore adapter (reads master account, trades via trade-only API agent) |
| `keeper/src/exchange/sim.mjs` | Simulated perps for tests / local runs |

Default pool edge is now 10 bps with a 6 bps floor (> 4.5 bps HL perps taker fee).

```bash
cd keeper && npm test
# read-only against live HyperCore: logs the orders it *would* place
DRY_RUN=1 RPC_URL=... POOL=0x... HL_ACCOUNT=0xYourHLAccount node hedger.mjs
# live on HL testnet (fund via https://app.hyperliquid-testnet.xyz/drip, create an API agent wallet)
HL_TESTNET=1 RPC_URL=... POOL=0x... QUOTER_KEY=... HL_ACCOUNT=0x... HL_AGENT_KEY=0x... node hedger.mjs
```

## Step 4 — Fast bridge ✅ (local e2e with simulated HyperCore; real HL sends pending your testnet account)

`src/bridge/FastBridge.sol` + `keeper/relayer.mjs`.

- **In:** `deposit(token, amount, minUsdcOut, hlRecipient, deadline)` — USDC, or any token with a PropAMM pool (converted in the same tx). Relayer credits the user's own HyperCore account from our inventory, then `markFulfilled`. Not fulfilled within `refundDelay` (1h) → user calls `refund` for the full amount.
- **Out:** user `usdSend`s to our HyperCore account; relayer calls `payout(hlTxHash, user, amount)` — once per hash, per-payout and daily caps.
- **Credit:** deposits can't exceed `credit` = our HyperCore balance − unsent obligations − buffer, set by compare-and-set so a stale read reverts.
- **Relayer safety:** write-ahead log (`relayer-state.json`), ledger-verified crash recovery, 30 s wait before any resend, never sends deposits within 10 min of refund, refuses ambiguous matches.
- Fee: 0.05%, min $0.50, both directions.

```bash
./script/e2e-bridge.sh    # full local run: anvil + pool + bridge + relayer, live HYPE prices
# live (HL testnet): relayer key on Elysium + inventory account MAIN key on HyperCore (usdSend needs it)
RPC_URL=... BRIDGE=0x... RELAYER_KEY=0x... HL_MAIN_KEY=0x... HL_TESTNET=1 node keeper/relayer.mjs
```

Open before mainnet: confirm HyperCore's own usdSend fee is below our min fee; move inventory-account key to a secured signer; automate rebalancing (manual for now via `withdrawLiquidity`).

### Testnet RPCs
- Official: `https://testnet-rpc.elysium.kinetiq.xyz` (`--rpc-url elysium_testnet`)
- Fallback: `https://elysium-testnet-rpc.hypedexer.com/` (`elysium_testnet_alt`) — third-party Nitro node, verified same chain (99801, matching block hashes), can trail a few blocks; HTTP only.

### Chain facts verified against testnet (2026-09-23)
- HyperCore read precompile and `ElysiumCoreWriter` are **not live**; both ship ~4 weeks after mainnet, ABI unpublished.
- Nitro precompiles (ArbSys `0x64`) aren't executed by Foundry forks — tests install a stand-in.
- `block.number` executed on Elysium returns HyperEVM's height (verified via eth_call); Foundry forks don't emulate this.
- `block.timestamp` has 1 s resolution; blocks are produced only when there are transactions.
