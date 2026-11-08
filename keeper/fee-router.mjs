// Fee router service (src/fees/router.mjs): every SCAN_MS it has our tokens' Ascend escrows pay out our builder fee, records
// what arrived and updates stakers' Neuriio (src/fees/neuriio.mjs); every PAY_MS it pays the fees out.
// KEY is our builder address's key (0xB153AA503a2C95fC175275D6b93415869A77e3d1, approved by Ascend): every escrow pays it.
// Without SEND=1 it only logs what it would do. SEND=1 also needs ASCEND_CHECKED=1, once test/fork/AscendMainnet.t.sol has
// passed against Ascend's live contracts.
//
// env: KEY (the fee wallet's private key; ./script/run-fee-router.sh decrypts a keystore into it), RPC_URL, CHAIN_ID,
//      SUPABASE_URL, SUPABASE_SERVICE_KEY, USDC, STAKING, LAUNCHER, TREASURY, FROM_BLOCK, ESCROW_FACTORY and LAUNCHPAD
//      (Ascend's, mainnet defaults), CONFIRMATIONS (20), MAX_RANGE (5000), MIN_PAYOUT_USDC (10), MIN_SETTLE_USDC (3: a pool's
//      waiting fees before we pay gas to settle them; Ascend's crank settles too), MIN_CLAIM_USDC (1), SCAN_MS (60000),
//      PAY_MS (3600000), SEND, ASCEND_CHECKED, ONCE=1 (one pass, exit)
// Partner fees (src/fees/partner.mjs: outside tokens traded through NeuriioSwap, stakers paid in USDC from a float): OFF unless
//      PARTNER_TOKENS is set (comma-separated token addresses, user's call, each also listed on NeuriioPartnerStaking). Then
//      also: PARTNER_STAKING, NEURIIO_SWAPS (comma-separated), PARTNER_FROM_BLOCK, WHYPE (mainnet default),
//      MIN_PARTNER_PAYOUT_USDC (10), PARTNER_FLOAT_WARN_USDC (100). Needs migration 20261107200000_partner_fees.sql.
import { createPublicClient, createWalletClient, defineChain, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeTransport } from "./src/rpc.mjs";
import { supabaseLedger } from "./src/fees/ledger.mjs";
import { makeNeuriioTally, supabaseNeuriioStore } from "./src/fees/neuriio.mjs";
import { makeFeeRouter } from "./src/fees/router.mjs";
import { hyperliquidHypeUsd, makePartnerRouter } from "./src/fees/partner.mjs";

const env = (k, d) => process.env[k] ?? d;
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const log = (ev, o = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...o }));

const send = env("SEND") === "1";
if (send && env("ASCEND_CHECKED") !== "1") throw new Error("SEND=1 needs ASCEND_CHECKED=1: run test/fork/AscendMainnet.t.sol against Ascend's live contracts first");

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
const mainLedger = supabaseLedger(need("SUPABASE_URL"), need("SUPABASE_SERVICE_KEY"));
const router = makeFeeRouter({
  pub,
  wallet,
  log,
  ledger: mainLedger,
  cfg: {
    usdc: need("USDC"),
    staking: need("STAKING"),
    launcher: need("LAUNCHER"),
    escrowFactory: env("ESCROW_FACTORY", "0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19"),
    launchpad: env("LAUNCHPAD", "0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC"),
    treasury: need("TREASURY"),
    fromBlock: need("FROM_BLOCK"),
    confirmations: Number(env("CONFIRMATIONS", 20)),
    maxRange: Number(env("MAX_RANGE", 5000)),
    minPayout: parseUnits(env("MIN_PAYOUT_USDC", "10"), 6),
    minSettle: parseUnits(env("MIN_SETTLE_USDC", "3"), 6),
    minClaim: parseUnits(env("MIN_CLAIM_USDC", "1"), 6),
    receiptTimeoutMs: 120_000,
    send,
  },
});

const neuriio = makeNeuriioTally({
  pub,
  log,
  store: supabaseNeuriioStore(need("SUPABASE_URL"), need("SUPABASE_SERVICE_KEY")),
  cfg: { staking: need("STAKING"), partnerStaking: env("PARTNER_STAKING") || undefined, feeWallet: wallet.account.address, fromBlock: need("FROM_BLOCK"), confirmations: Number(env("CONFIRMATIONS", 20)), maxRange: Number(env("MAX_RANGE", 5000)) },
});

const list = (k) => env(k, "").split(",").map((s) => s.trim()).filter(Boolean);
const partnerTokens = list("PARTNER_TOKENS");
const partner = partnerTokens.length
  ? makePartnerRouter({
      pub,
      wallet,
      log,
      ledger: supabaseLedger(need("SUPABASE_URL"), need("SUPABASE_SERVICE_KEY"), { prefix: "partner_", cursor: "fees:partner:cursor" }),
      cfg: {
        usdc: need("USDC"),
        whype: env("WHYPE", "0xbA876237B0F021A6c6D852d6c26E107997cC5E81"),
        staking: need("PARTNER_STAKING"),
        swaps: list("NEURIIO_SWAPS"),
        tokens: partnerTokens,
        fromBlock: need("PARTNER_FROM_BLOCK"),
        confirmations: Number(env("CONFIRMATIONS", 20)),
        maxRange: Number(env("MAX_RANGE", 5000)),
        minPayout: parseUnits(env("MIN_PARTNER_PAYOUT_USDC", "10"), 6),
        floatWarn: parseUnits(env("PARTNER_FLOAT_WARN_USDC", "100"), 6),
        receiptTimeoutMs: 120_000,
        send,
        hypeUsd: () => hyperliquidHypeUsd(),
        // USDC the main fee router still owes (Ascend fees recorded, not yet paid out): the float never spends it
        reserve: async () => (await mainLedger.unpaidMatched()).reduce((a, r) => a + r.amount, 0n) + (await mainLedger.unmatchedTotal()),
      },
    })
  : null;
if (partner && !list("NEURIIO_SWAPS").length) throw new Error("PARTNER_TOKENS needs NEURIIO_SWAPS");

const safely = (name, fn) => async () => {
  try {
    await fn();
  } catch (e) {
    log("error", { in: name, error: e.shortMessage ?? e.message });
  }
};
const collectFees = safely("collect", router.collect);
const scanFees = safely("scan", router.scan);
const scanNeuriio = safely("neuriio", neuriio.scan);
const scanPartner = partner ? safely("partner_scan", partner.scan) : async () => {};
const scan = async () => {
  await collectFees();
  await scanFees();
  await scanPartner();
  await scanNeuriio();
};
const payMain = safely("pay", router.pay);
const payPartner = partner ? safely("partner_pay", partner.pay) : async () => {};
const pay = async () => {
  await payMain(); // first: what it owes is reserved from the partner float
  await payPartner();
};

log("start", { wallet: wallet.account.address, send, partnerTokens: partnerTokens.length ? partnerTokens : "off" });
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
