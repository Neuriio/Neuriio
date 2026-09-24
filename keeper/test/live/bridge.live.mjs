// Live FastBridge round trip on Elysium testnet + Hyperliquid testnet, from a throwaway trader.
// Run via script/bridge-test.sh (it funds the trader with gas first). Needs the relayer running.
//   1. deposit 50 tUSDC on Elysium  -> relayer credits the trader's own HyperCore testnet account
//   2. trader usdSends 20 USDC back to our inventory account on HyperCore -> relayer pays out on Elysium
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";

const { RPC_URL, TRADER_KEY, BRIDGE, USDC, INVENTORY } = process.env;
const transport = http(RPC_URL);
const pub = createPublicClient({ transport });
const chain = { id: 99801, name: "elysium-testnet", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const trader = privateKeyToAccount(TRADER_KEY);
const wallet = createWalletClient({ account: trader, transport, chain });
const hlTransport = new HttpTransport({ isTestnet: true });
const hlInfo = new InfoClient({ transport: hlTransport });
const hlEx = new ExchangeClient({ transport: hlTransport, wallet: trader });

const erc20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const bridgeAbi = parseAbi([
  "function deposit(address token, uint256 amountIn, uint256 minUsdcOut, address hlRecipient, uint256 deadline) returns (uint256)",
  "function depositCount() view returns (uint256)",
  "function deposits(uint256) view returns (address, uint64, uint8, address, uint96, uint96)",
  "function credit() view returns (uint256)",
]);
const tx = async (address, abi, functionName, args) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
  return hash;
};
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const hlBalance = async (user) => Number((await hlInfo.clearinghouseState({ user })).withdrawable);
const poll = async (label, fn, timeoutMs = 90_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, secs: ((Date.now() - t0) / 1000).toFixed(1) };
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};

console.log(`trader ${trader.address}`);
console.log(`bridge credit before: ${formatUnits(await read(BRIDGE, bridgeAbi, "credit"), 6)} USDC`);

console.log("\n== 1) Elysium -> HyperCore: deposit 50 tUSDC");
await tx(USDC, erc20, "mint", [trader.address, parseUnits("100", 6)]);
await tx(USDC, erc20, "approve", [BRIDGE, parseUnits("100", 6)]);
const hlBefore = await hlBalance(trader.address);
const depHash = await tx(BRIDGE, bridgeAbi, "deposit", [USDC, parseUnits("50", 6), 0n, trader.address, BigInt(Math.floor(Date.now() / 1000) + 300)]);
const id = await read(BRIDGE, bridgeAbi, "depositCount");
const d = await read(BRIDGE, bridgeAbi, "deposits", [id]);
console.log(`   deposit #${id} tx ${depHash}: promised ${formatUnits(d[4], 6)} USDC (fee ${formatUnits(d[5], 6)})`);
const credited = await poll("HyperCore credit", async () => {
  const b = await hlBalance(trader.address);
  return b > hlBefore ? b : null;
});
console.log(`   ✔ trader's HyperCore testnet account now holds ${credited.v} USDC (after ${credited.secs}s)`);
const fulfilled = await poll("deposit marked fulfilled", async () => ((await read(BRIDGE, bridgeAbi, "deposits", [id]))[2] === 2 ? true : null));
console.log(`   ✔ deposit #${id} marked fulfilled on Elysium (after ${fulfilled.secs}s more)`);

console.log("\n== 2) HyperCore -> Elysium: trader sends 20 USDC to our inventory account");
const elyBefore = await read(USDC, erc20, "balanceOf", [trader.address]);
try {
  await hlEx.usdSend({ destination: INVENTORY, amount: "20" });
} catch (e) {
  console.log(`   ✖ HyperCore refused the send: ${e.message.split("\n")[0]}`);
  process.exit(1);
}
console.log(`   usdSend accepted on HyperCore`);
const paid = await poll("Elysium payout", async () => {
  const b = await read(USDC, erc20, "balanceOf", [trader.address]);
  return b > elyBefore ? b - elyBefore : null;
});
console.log(`   ✔ trader received ${formatUnits(paid.v, 6)} tUSDC on Elysium (after ${paid.secs}s)`);
console.log(`\nbridge credit after: ${formatUnits(await read(BRIDGE, bridgeAbi, "credit"), 6)} USDC`);
console.log("BRIDGE ROUND TRIP OK");
