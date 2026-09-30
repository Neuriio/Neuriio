// Protocol-fee payout bot: every CHECK_MS it looks at each FeeVault (deployments `feeVaults`, else `feeVault`) and,
// once the protocol share waiting there (community + buyback) reaches MIN_HYPE and both wallets are set, calls
// payProtocol(), which sends it to the protocol wallets. payProtocol is permissionless, so the key only pays gas
// (use a small separate keystore with a little HYPE; it never holds or receives fees).
//
// env: KEY (payer private key; ./script/run-pay-protocol.sh decrypts a keystore into it), RPC_URL, MIN_HYPE (0.01),
//      CHECK_MS (3600000 = hourly), DEPLOYMENTS (default ../deployments/elysium-testnet.json), ONCE=1 (one pass, exit)
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatEther, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeTransport } from "./src/rpc.mjs";

const env = (k, d) => process.env[k] ?? d;
const dep = JSON.parse(readFileSync(new URL(env("DEPLOYMENTS", "../deployments/elysium-testnet.json"), import.meta.url)));
const RPC_URL = env("RPC_URL", "https://testnet-rpc.elysium.kinetiq.xyz,https://elysium-testnet-rpc.hypedexer.com/");
const MIN = parseEther(env("MIN_HYPE", "0.01"));
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
  "function communityBalance() view returns (uint256)",
  "function buybackBalance() view returns (uint256)",
  "function communityWallet() view returns (address)",
  "function buybackWallet() view returns (address)",
  "function payProtocol()",
]);
const ZERO = /^0x0{40}$/i;
const log = (ev, o = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...o }));
const vaults = () => [...new Set([dep.feeVault, ...(dep.feeVaults ?? [])].map((v) => v.toLowerCase()))];

async function check() {
  for (const vault of vaults()) {
    try {
      const [c, b, cw, bw] = await Promise.all(
        ["communityBalance", "buybackBalance", "communityWallet", "buybackWallet"].map((functionName) =>
          pub.readContract({ address: vault, abi: vaultAbi, functionName }),
        ),
      );
      const pending = c + b;
      if (ZERO.test(cw) || ZERO.test(bw)) {
        log("wallets_not_set", { vault, pending: formatEther(pending) });
        continue;
      }
      if (pending < MIN) {
        log("below_min", { vault, pending: formatEther(pending), min: formatEther(MIN) });
        continue;
      }
      const hash = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "payProtocol" });
      const r = await pub.waitForTransactionReceipt({ hash });
      log(r.status === "success" ? "paid" : "reverted", { vault, amount: formatEther(pending), to: { community: cw, buyback: bw }, tx: hash });
    } catch (e) {
      log("error", { vault, error: e.shortMessage ?? e.message });
    }
  }
}

log("start", { payer: wallet.account.address, vaults: vaults(), min: formatEther(MIN), everyMs: CHECK_MS });
await check();
if (env("ONCE") === "1") process.exit(0); // (the RPC transport's stats timer would keep the process alive)
setInterval(check, CHECK_MS);
