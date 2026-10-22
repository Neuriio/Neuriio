// Protocol-fee payout bot: every CHECK_MS it looks at each FeeVault (deployments `feeVaults`, else `feeVault`) and,
// once the protocol share waiting there (treasury or community, + buyback) reaches the minimum (MIN_USDC for the USDC
// world's vaults, MIN_HYPE for the old HYPE world's) and both wallets are set, calls
// payProtocol(), which sends it to the protocol wallets. payProtocol is permissionless, so the key only pays gas
// (use a small separate keystore with a little HYPE; it never holds or receives fees).
//
// env: KEY (payer private key; ./script/run-pay-protocol.sh decrypts a keystore into it), RPC_URL, MIN_USDC (1),
//      MIN_HYPE (0.01),
//      CHECK_MS (3600000 = hourly), DEPLOYMENTS (default ../deployments/elysium-testnet.json), ONCE=1 (one pass, exit)
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatUnits, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeTransport } from "./src/rpc.mjs";

const env = (k, d) => process.env[k] ?? d;
const dep = JSON.parse(readFileSync(new URL(env("DEPLOYMENTS", "../deployments/elysium-testnet.json"), import.meta.url)));
const RPC_URL = env("RPC_URL", "https://testnet-rpc.elysium.kinetiq.xyz"); // hypedexer stopped syncing 2026-10-21
// the least worth a payout tx: MIN_HYPE for the old HYPE world's vaults, MIN_USDC for the USDC world's
const MIN_HYPE = env("MIN_HYPE", "0.01");
const MIN_USDC = env("MIN_USDC", "1");
const CHECK_MS = Number(env("CHECK_MS", 3_600_000));
const KEY = env("KEY");
if (!KEY) throw new Error("KEY is required (use ./script/run-pay-protocol.sh)");

const chain = defineChain({
  id: dep.chainId ?? 99801,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: RPC_URL.split(",") } },
});
const transport = makeTransport(RPC_URL, { name: "pay-protocol" });
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(KEY) });
const vaultAbi = parseAbi([
  "function communityBalance() view returns (uint256)", // HYPE-world vaults
  "function communityWallet() view returns (address)",
  "function treasuryBalance() view returns (uint256)", // USDC-world vaults
  "function treasuryWallet() view returns (address)",
  "function buybackBalance() view returns (uint256)",
  "function buybackWallet() view returns (address)",
  "function quote() view returns (address)",
  "function payProtocol()",
]);
const ZERO = /^0x0{40}$/i;
const log = (ev, o = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...o }));
const vaults = () => [...new Set([dep.feeVault, ...(dep.feeVaults ?? [])].map((v) => v.toLowerCase()))];

/** A vault's layout: the protocol share sits in `treasury*` (the USDC world's vaults) or `community*` (the HYPE
 *  world's, and the USDC world's first vault), in USDC if the vault has quote(), else in HYPE. */
async function kind(vault) {
  const has = (functionName) => pub.readContract({ address: vault, abi: vaultAbi, functionName }).then(() => true, () => false);
  const [usdc, treasury] = await Promise.all([has("quote"), has("treasuryWallet")]);
  const [balance, wallet] = treasury ? ["treasuryBalance", "treasuryWallet"] : ["communityBalance", "communityWallet"];
  return usdc
    ? { balance, wallet, decimals: 6, unit: "USDC", min: parseUnits(MIN_USDC, 6) }
    : { balance, wallet, decimals: 18, unit: "HYPE", min: parseUnits(MIN_HYPE, 18) };
}

async function check() {
  for (const vault of vaults()) {
    try {
      const k = await kind(vault);
      const [c, b, cw, bw] = await Promise.all(
        [k.balance, "buybackBalance", k.wallet, "buybackWallet"].map((functionName) =>
          pub.readContract({ address: vault, abi: vaultAbi, functionName }),
        ),
      );
      const pending = c + b;
      const fmt = (v) => `${formatUnits(v, k.decimals)} ${k.unit}`;
      if (ZERO.test(cw) || ZERO.test(bw)) {
        log("wallets_not_set", { vault, pending: fmt(pending) });
        continue;
      }
      if (pending < k.min) {
        log("below_min", { vault, pending: fmt(pending), min: fmt(k.min) });
        continue;
      }
      const hash = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "payProtocol" });
      const r = await pub.waitForTransactionReceipt({ hash });
      log(r.status === "success" ? "paid" : "reverted", { vault, amount: fmt(pending), to: { treasury: cw, buyback: bw }, tx: hash });
    } catch (e) {
      log("error", { vault, error: e.shortMessage ?? e.message });
    }
  }
}

log("start", { payer: wallet.account.address, vaults: vaults(), minHype: MIN_HYPE, minUsdc: MIN_USDC, everyMs: CHECK_MS });
await check();
if (env("ONCE") === "1") process.exit(0); // (the RPC transport's stats timer would keep the process alive)
setInterval(check, CHECK_MS);
