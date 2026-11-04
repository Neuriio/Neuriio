// Fee router service (src/fees/router.mjs): every SCAN_MS it records the fees that arrived and updates stakers' Neuriio
// (src/fees/neuriio.mjs), every PAY_MS it pays the fees out.
// Without SEND=1 it only logs what it would pay. SEND=1 also needs ASCEND_SWAP_CONFIRMED=1, once src/fees/ascend.mjs has been
// checked against Ascend's real contracts.
//
// env: KEY (the fee wallet's private key; ./script/run-fee-router.sh decrypts a keystore into it), RPC_URL, CHAIN_ID,
//      SUPABASE_URL, SUPABASE_SERVICE_KEY, USDC, STAKING, LAUNCHER, POOL_MANAGER, TREASURY, FROM_BLOCK, FEE_SOURCE (optional:
//      the only address fees may come from), CONFIRMATIONS (20), MAX_RANGE (5000), MIN_PAYOUT_USDC (10), SCAN_MS (60000),
//      PAY_MS (3600000), SEND, ASCEND_SWAP_CONFIRMED, ONCE=1 (one pass, exit)
import { createPublicClient, createWalletClient, defineChain, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeTransport } from "./src/rpc.mjs";
import { supabaseLedger } from "./src/fees/ledger.mjs";
import { makeNeuriioTally, supabaseNeuriioStore } from "./src/fees/neuriio.mjs";
import { makeFeeRouter } from "./src/fees/router.mjs";

const env = (k, d) => process.env[k] ?? d;
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const log = (ev, o = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...o }));

const send = env("SEND") === "1";
if (send && env("ASCEND_SWAP_CONFIRMED") !== "1") throw new Error("SEND=1 needs ASCEND_SWAP_CONFIRMED=1: check src/fees/ascend.mjs against Ascend's contracts first");

const RPC_URL = need("RPC_URL");
const chain = defineChain({
  id: Number(need("CHAIN_ID")),
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: RPC_URL.split(",") } },
});
const transport = makeTransport(RPC_URL, { name: "fee-router" });
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(need("KEY")) });
const router = makeFeeRouter({
  pub,
  wallet,
  log,
  ledger: supabaseLedger(need("SUPABASE_URL"), need("SUPABASE_SERVICE_KEY")),
  cfg: {
    usdc: need("USDC"),
    staking: need("STAKING"),
    launcher: need("LAUNCHER"),
    poolManager: need("POOL_MANAGER"),
    treasury: need("TREASURY"),
    feeSource: env("FEE_SOURCE"),
    fromBlock: need("FROM_BLOCK"),
    confirmations: Number(env("CONFIRMATIONS", 20)),
    maxRange: Number(env("MAX_RANGE", 5000)),
    minPayout: parseUnits(env("MIN_PAYOUT_USDC", "10"), 6),
    receiptTimeoutMs: 120_000,
    send,
  },
});

const neuriio = makeNeuriioTally({
  pub,
  log,
  store: supabaseNeuriioStore(need("SUPABASE_URL"), need("SUPABASE_SERVICE_KEY")),
  cfg: { staking: need("STAKING"), feeWallet: wallet.account.address, fromBlock: need("FROM_BLOCK"), confirmations: Number(env("CONFIRMATIONS", 20)), maxRange: Number(env("MAX_RANGE", 5000)) },
});

const safely = (name, fn) => async () => {
  try {
    await fn();
  } catch (e) {
    log("error", { in: name, error: e.shortMessage ?? e.message });
  }
};
const scanFees = safely("scan", router.scan);
const scanNeuriio = safely("neuriio", neuriio.scan);
const scan = async () => {
  await scanFees();
  await scanNeuriio();
};
const pay = safely("pay", router.pay);

log("start", { wallet: wallet.account.address, send });
await scan();
await pay();
if (env("ONCE") === "1") process.exit(0);
let busy = false; // a slow pass never overlaps the next
const once = (fn) => async () => {
  if (busy) return;
  busy = true;
  await fn().finally(() => (busy = false));
};
setInterval(once(scan), Number(env("SCAN_MS", 60_000)));
setInterval(once(pay), Number(env("PAY_MS", 3_600_000)));
