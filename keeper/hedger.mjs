// Runs the hedging engine against a deployed PropAMM.
//
//   RPC_URL=... POOL=0x... QUOTER_KEY=0x... HL_ACCOUNT=0x... HL_AGENT_KEY=0x... node hedger.mjs
//
// Modes:  DRY_RUN=1  read live HyperCore state, log planned orders, never trade or pause
//         SIM=1      simulated HyperCore perps (SIM_MID sets the price), for local testing
// Tuning: COIN=HYPE HL_TESTNET=0 HEDGE_RATIO=1 MAX_SLIPPAGE_BPS=20 MIN_NOTIONAL=10
//         MAX_UNHEDGED_USD=500 GRACE_MS=3000 INTERVAL_MS=2000
import { createPublicClient, createWalletClient, parseAbi } from "viem";
import { makeTransport, primaryUrl } from "./src/rpc.mjs";
import { privateKeyToAccount } from "viem/accounts";
import { Hedger } from "./src/hedger.mjs";
import { fromUnits } from "./src/planner.mjs";
import { SimExchange } from "./src/exchange/sim.mjs";
import { HyperliquidExchange } from "./src/exchange/hyperliquid.mjs";

const env = process.env;
const need = (k) => env[k] ?? (console.error(`${k} is required`), process.exit(1));
const num = (k, d) => (env[k] === undefined ? d : Number(env[k]));

const poolAbi = parseAbi([
  "function baseReserve() view returns (uint128)",
  "function base() view returns (address)",
  "function pause()",
  "function paused() view returns (bool)",
  "event Swap(address indexed sender, address indexed recipient, bool indexed buyBase, uint256 baseAmount, uint256 quoteAmount, uint256 priceWad, uint256 coreMidWad, uint64 coreTimeMs, uint128 baseReserve, uint128 quoteReserve)",
]);

const RPC_URL = need("RPC_URL");
const POOL = need("POOL");
const transport = makeTransport(RPC_URL, { name: "hedger" });
const pub = createPublicClient({ transport });
const chain = { id: await pub.getChainId(), name: "target", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [primaryUrl(RPC_URL)] } } };

const baseToken = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "base" });
const baseDecimals = await pub.readContract({ address: baseToken, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });

const cfg = {
  hedgeRatio: num("HEDGE_RATIO", 1),
  maxSlippageBps: num("MAX_SLIPPAGE_BPS", 20),
  minNotional: num("MIN_NOTIONAL", 10),
  maxUnhedgedUsd: num("MAX_UNHEDGED_USD", 500),
  graceMs: num("GRACE_MS", 3000),
  dryRun: env.DRY_RUN === "1",
};

const exchange =
  env.SIM === "1"
    ? new SimExchange({ mid: num("SIM_MID", 93.61) })
    : new HyperliquidExchange({
        coin: env.COIN ?? "HYPE",
        account: need("HL_ACCOUNT"),
        agentKey: cfg.dryRun ? undefined : need("HL_AGENT_KEY"),
        testnet: env.HL_TESTNET === "1",
      });

const quoter = cfg.dryRun ? null : createWalletClient({ account: privateKeyToAccount(need("QUOTER_KEY")), transport });

const hedger = new Hedger({
  exchange,
  cfg,
  getPoolBase: async () =>
    fromUnits(await pub.readContract({ address: POOL, abi: poolAbi, functionName: "baseReserve" }), baseDecimals),
  pausePool: async () => {
    const hash = await quoter.writeContract({ chain, address: POOL, abi: poolAbi, functionName: "pause" });
    await pub.waitForTransactionReceipt({ hash });
  },
});

console.log(JSON.stringify({ ev: "start", pool: POOL, mode: env.SIM === "1" ? "sim" : cfg.dryRun ? "dry-run" : "live", ...cfg }));

pub.watchContractEvent({
  address: POOL,
  abi: poolAbi,
  eventName: "Swap",
  pollingInterval: 1000, // was 250ms: 4 req/s on its own was the main cause of public-RPC rate limits
  onLogs: () => hedger.reconcile("swap").catch((e) => console.error("reconcile failed:", e.message)),
});

const tick = () => hedger.reconcile("timer").catch((e) => console.error("reconcile failed:", e.message));
await tick();
if (env.ONCE === "1") process.exit(0);
setInterval(tick, num("INTERVAL_MS", 2000));
