// Testnet-only helper for the Privy check page (app/): serves the deployment config and mints
// mock tHYPE into a user's Neuriio wallet (stands in for "the user deposits").
//
//   FAUCET_KEY=0x... RPC_URL=... INVENTORY=0x... node test/live/privy-faucet.mjs
//
// Run via script/privy-check.sh. Never run against mainnet: it only works because tHYPE has a public mint.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeTransport } from "../../src/rpc.mjs";

const { FAUCET_KEY, RPC_URL, INVENTORY, PORT = "8788" } = process.env;
const d = JSON.parse(readFileSync(new URL("../../../deployments/elysium-testnet.json", import.meta.url)));
const chain = { id: 99801, name: "elysium-testnet", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const transport = makeTransport(RPC_URL, { name: "privy-faucet", statsEveryMs: 0 });
const pub = createPublicClient({ transport });
const wallet = createWalletClient({ account: privateKeyToAccount(FAUCET_KEY), transport, chain });
const mint = parseAbi(["function mint(address,uint256)"]);
const config = { chainId: 99801, rpcUrl: RPC_URL, delegate: d.neuriioAccount, bridge: d.fastBridge, usdc: d.tUSDC, hype: d.tHYPE, inventory: INVENTORY };
const minted = new Set(); // one mint per address per run

const reply = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return reply(res, 204, {});
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/config") return reply(res, 200, config);
  if (req.method === "POST" && url.pathname === "/mint") {
    const to = url.searchParams.get("to") ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return reply(res, 400, { error: "bad address" });
    if (minted.has(to.toLowerCase())) return reply(res, 400, { error: "already funded this run" });
    minted.add(to.toLowerCase());
    try {
      const hash = await wallet.writeContract({ address: d.tHYPE, abi: mint, functionName: "mint", args: [to, parseUnits("3", 18)] });
      await pub.waitForTransactionReceipt({ hash });
      return reply(res, 200, { hash, amount: "3 tHYPE" });
    } catch (e) {
      minted.delete(to.toLowerCase());
      return reply(res, 500, { error: e.shortMessage ?? e.message });
    }
  }
  reply(res, 404, { error: "not found" });
}).listen(Number(PORT), () => console.log(JSON.stringify({ ev: "start", faucet: wallet.account.address, port: Number(PORT) })));
