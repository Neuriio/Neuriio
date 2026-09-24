// Runs the FastBridge relayer.
//
//   RPC_URL=... BRIDGE=0x... RELAYER_KEY=0x... HL_MAIN_KEY=0x... node relayer.mjs
//
// HL_MAIN_KEY is the inventory account's main key (usdSend can't be signed by an API agent):
// keep only a working balance on that account.
// Env: HL_TESTNET=1  STATE_FILE=./relayer-state.json  TICK_MS=1000
//      CREDIT_BUFFER=100 (USDC kept back from credit)  CREDIT_STEP=50  REFUND_MARGIN_S=600  RESEND_AFTER_S=30
//      TOPUP_FROM=0xabc,0xdef  treasury wallets: their transfers to the inventory account are top-ups, not withdrawals
import { createPublicClient, createWalletClient } from "viem";
import { makeTransport, primaryUrl } from "./src/rpc.mjs";
import { privateKeyToAccount } from "viem/accounts";
import { BridgeChain } from "./src/bridge/chain.mjs";
import { HlTransfers } from "./src/bridge/hl-live.mjs";
import { Relayer } from "./src/bridge/relayer.mjs";
import { strToUsdc } from "./src/bridge/units.mjs";
import { JsonStore } from "./src/store.mjs";

const env = process.env;
const need = (k) => env[k] ?? (console.error(`${k} is required`), process.exit(1));
const num = (k, d) => (env[k] === undefined ? d : Number(env[k]));

const RPC_URL = need("RPC_URL");
const transport = makeTransport(RPC_URL, { name: "relayer" });
const pub = createPublicClient({ transport });
const chainDef = { id: await pub.getChainId(), name: "target", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [primaryUrl(RPC_URL)] } } };
const wallet = createWalletClient({ account: privateKeyToAccount(need("RELAYER_KEY")), transport, chain: chainDef });

const chain = new BridgeChain({ pub, wallet, chain: chainDef, address: need("BRIDGE") });
const hl = new HlTransfers({ mainKey: need("HL_MAIN_KEY"), testnet: env.HL_TESTNET === "1" });

const relayer = new Relayer({
  chain,
  hl,
  store: new JsonStore(env.STATE_FILE ?? "./relayer-state.json"),
  cfg: {
    refundDelayMs: await chain.refundDelayMs(),
    refundMarginMs: num("REFUND_MARGIN_S", 600) * 1000,
    resendAfterMs: num("RESEND_AFTER_S", 30) * 1000,
    creditBuffer: strToUsdc(env.CREDIT_BUFFER ?? "100"),
    creditStep: strToUsdc(env.CREDIT_STEP ?? "50"),
    topupFrom: (env.TOPUP_FROM ?? "").split(",").filter(Boolean),
  },
});

console.log(JSON.stringify({ ev: "start", bridge: env.BRIDGE, hlAccount: hl.account, testnet: env.HL_TESTNET === "1" }));
const tick = () => relayer.tick().catch((e) => console.error(JSON.stringify({ ev: "tick_failed", error: e.shortMessage ?? e.message })));
await tick();
setInterval(tick, num("TICK_MS", 1000));
