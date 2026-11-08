// Launch check service (src/launchcheck/): works out who bought each token right after launch and which of them are tied together, for
// Explore's Launch check widget. Reads the chain and writes to Supabase; holds no key and sends nothing.
//
// env: RPC_URL, CHAIN_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY, REGISTRY (whose tokens), USDC, STAKING (optional: staked tokens count as held),
//      MULTICALL (default the standard Multicall3), IGNORE (comma-separated addresses that tie nobody together: exchanges, bridges, faucets),
//      WINDOW_SECONDS (60), EARLY_BLOCKS (1200), LOOKBACK_BLOCKS (100000: funding read from ~6 hours before the launch at mainnet's
//      0.21 s blocks), MAX_WALLETS (50), HUB_RECIPIENTS (25),
//      PASS_MS (60000), HOLDERS_MS (300000: top holders pass), ONCE=1 (one pass, exit), TOP (15: also check Explore's Verified list, Ascend's top coins by 24h volume;
//      0 = only our own launches)
import { createPublicClient, defineChain } from "viem";
import { makeTransport } from "./src/rpc.mjs";
import { makeLaunchChecker, supabaseLaunchStore } from "./src/launchcheck/check.mjs";
import { makeHolderScanner, supabaseHolderStore } from "./src/holders/holders.mjs";

const env = (k, d) => process.env[k] ?? d;
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const log = (ev, o = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...o }));

const RPC_URL = need("RPC_URL");
const chain = defineChain({
  id: Number(need("CHAIN_ID")),
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: RPC_URL.split(",") } },
  contracts: { multicall3: { address: env("MULTICALL", "0xcA11bde05977b3631167028862bE2a173976CA11") } },
});
const pub = createPublicClient({ chain, transport: makeTransport(RPC_URL, { name: "launch-check" }) });
const launchStore = supabaseLaunchStore(need("SUPABASE_URL"), need("SUPABASE_SERVICE_KEY"), need("REGISTRY").toLowerCase(), { top: Number(env("TOP", 15)) });
const checker = makeLaunchChecker({
  pub,
  log,
  store: launchStore,
  cfg: {
    usdc: need("USDC"),
    staking: env("STAKING"),
    ignored: env("IGNORE", "").split(",").filter(Boolean),
    windowSeconds: Number(env("WINDOW_SECONDS", 60)),
    earlyBlocks: Number(env("EARLY_BLOCKS", 1200)),
    lookbackBlocks: Number(env("LOOKBACK_BLOCKS", 100_000)),
    maxWallets: Number(env("MAX_WALLETS", 50)),
    hubRecipients: Number(env("HUB_RECIPIENTS", 25)),
  },
});

const pass = async () => {
  try {
    await checker.pass();
  } catch (e) {
    log("error", { in: "pass", error: e.shortMessage ?? e.message });
  }
};
// Top holders (user, 2026-11-08): the same coins, every HOLDERS_MS (5 minutes); its own loop so a long first fill never delays checks
const holders = makeHolderScanner({ pub, log, store: supabaseHolderStore(need("SUPABASE_URL"), need("SUPABASE_SERVICE_KEY"), launchStore.tokens) });
const holdersPass = async () => {
  try {
    await holders.pass();
  } catch (e) {
    log("error", { in: "holders_pass", error: e.shortMessage ?? e.message });
  }
};

log("start");
await Promise.all([pass(), holdersPass()]);
if (env("ONCE") === "1") process.exit(0);
let holdersBusy = false;
setInterval(async () => {
  if (holdersBusy) return;
  holdersBusy = true;
  await holdersPass().finally(() => (holdersBusy = false));
}, Number(env("HOLDERS_MS", 300_000)));
let busy = false; // a slow pass never overlaps the next
setInterval(async () => {
  if (busy) return;
  busy = true;
  await pass().finally(() => (busy = false));
}, Number(env("PASS_MS", 60_000)));
