// Step 6 of script/rehearse-ascend.sh: the real fee router (src/fees/router.mjs) on the rehearsal's local fork, with an
// in-memory ledger instead of Supabase. It has each of our tokens' escrows on the stand-in Ascend settle and pay out our
// builder fee, records each BuilderPaid as that token's fee, and pays 40% to its stakers and the rest to the treasury.
// env: RPC, KEY (fee wallet = builder), USDC, STAKING, LAUNCHER, ASCEND (the stand-in: its launchpad and escrow factory),
//      TREASURY, FROM_BLOCK
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { memoryLedger } from "./src/fees/ledger.mjs";
import { makeFeeRouter } from "./src/fees/router.mjs";

const e = (k) => {
  if (!process.env[k]) throw new Error(`${k} is required`);
  return process.env[k];
};
const chain = { id: 99801, name: "rehearsal", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [e("RPC")] } } };
const pub = createPublicClient({ chain, transport: http(e("RPC")) });
const wallet = createWalletClient({ chain, transport: http(e("RPC")), account: privateKeyToAccount(e("KEY")) });
const logs = [];
const router = makeFeeRouter({
  pub,
  wallet,
  ledger: memoryLedger(),
  log: (ev, o) => logs.push({ ev, ...o }),
  cfg: {
    usdc: e("USDC"), staking: e("STAKING"), launcher: e("LAUNCHER"), escrowFactory: e("ASCEND"), launchpad: e("ASCEND"),
    treasury: e("TREASURY"), fromBlock: BigInt(e("FROM_BLOCK")), confirmations: 0, maxRange: 5000, minPayout: 1n, minSettle: 1n,
    minClaim: 1n, send: true, receiptTimeoutMs: 30_000,
  },
});
await router.collect();
await router.scan();
await router.pay();
for (const l of logs) console.log(`  ${l.ev}`, JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => k !== "ev")), (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const unmatched = logs.filter((l) => l.ev === "fee_unmatched");
if (unmatched.length) throw new Error(`${unmatched.length} fees not matched to a token`);
