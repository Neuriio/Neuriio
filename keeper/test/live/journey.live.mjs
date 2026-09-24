// Full user journey on testnet, all three engines, from a throwaway trader:
//   1. swap + bridge: deposit tHYPE -> PropAMM converts to USDC -> FastBridge credits trader on HyperCore
//   2. onboard:       approve our builder fee + create a trade-only app agent (trader's main wallet)
//   3. trade:         3x HYPE long, $20 margin, via the trade hub (agent-signed, builder code attached),
//                     read portfolio, then close
//   4. withdraw:      trader sends USDC to our inventory account -> relayer pays out on Elysium
// Run via script/journey-test.sh (funds the trader with gas). Needs the bots running.
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { TradeHub } from "../../src/trade/hub.mjs";

const { RPC_URL, TRADER_KEY, BRIDGE, USDC, HYPE, POOL, INVENTORY } = process.env;
const MARKET = process.env.MARKET ?? "BTC"; // testnet HYPE perp book is empty on one side; BTC has depth
const transport = http(RPC_URL);
const pub = createPublicClient({ transport });
const chain = { id: 99801, name: "elysium-testnet", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const trader = privateKeyToAccount(TRADER_KEY);
const wallet = createWalletClient({ account: trader, transport, chain });

const erc20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const bridgeAbi = parseAbi([
  "function deposit(address token, uint256 amountIn, uint256 minUsdcOut, address hlRecipient, uint256 deadline) returns (uint256)",
  "function depositCount() view returns (uint256)",
  "function deposits(uint256) view returns (address, uint64, uint8, address, uint96, uint96)",
]);
const poolAbi = parseAbi(["function previewSellBase(uint256) view returns (uint256, uint256)"]);
const tx = async (address, abi, functionName, args) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
  return hash;
};
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const poll = async (label, fn, timeoutMs = 90_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, secs: ((Date.now() - t0) / 1000).toFixed(1) };
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const usd = (x) => `$${Number(x).toFixed(2)}`;

const hub = await new TradeHub({ testnet: true }).init(); // subscription model: no builder fee
const hlBal = async () => Number((await hub.info.clearinghouseState({ user: trader.address })).withdrawable);
console.log(`trader ${trader.address}\n`);

// ---------------------------------------------------------------- 1. swap + bridge
console.log("== 1) Swap + bridge: deposit 2 tHYPE, arrive as USDC on Hyperliquid");
await tx(HYPE, erc20, "mint", [trader.address, parseUnits("2", 18)]);
await tx(HYPE, erc20, "approve", [BRIDGE, parseUnits("2", 18)]);
// Retry when the pool refuses a stale oracle price (what a real app does transparently).
for (let attempt = 1; ; attempt++) {
  try {
    const [quoteUsdc] = await read(POOL, poolAbi, "previewSellBase", [parseUnits("2", 18)]);
    await tx(BRIDGE, bridgeAbi, "deposit", [HYPE, parseUnits("2", 18), (quoteUsdc * 99n) / 100n, trader.address, BigInt(Math.floor(Date.now() / 1000) + 300)]);
    break;
  } catch (e) {
    if (attempt >= 4) throw e;
    console.log(`   price was stale, retrying (${attempt})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const id = await read(BRIDGE, bridgeAbi, "depositCount");
const dep = await read(BRIDGE, bridgeAbi, "deposits", [id]);
console.log(`   pool swapped 2 tHYPE -> ${formatUnits(dep[4] + dep[5], 6)} USDC; bridge promised ${formatUnits(dep[4], 6)} (fee ${formatUnits(dep[5], 6)})`);
const arrived = await poll("HyperCore credit", async () => {
  const b = await hlBal();
  return b > 0 ? b : null;
});
console.log(`   ✔ ${usd(arrived.v)} USDC in the trader's own Hyperliquid account after ${arrived.secs}s`);

// ---------------------------------------------------------------- 2. onboard
console.log("\n== 2) Onboard to the trade hub (signed once by the trader's main wallet)");
await hub.approveBuilder(trader); // no-op: no builder fee
const agent = await hub.createAgent(trader, "elysium-test");
const agentAcct = privateKeyToAccount(agent.key);
const status = await hub.onboardingStatus(trader.address);
console.log(`   ✔ builder fee required: ${status.builderFeeRequired} | app agent ${agent.address} (trade-only)`);

// ---------------------------------------------------------------- 3. trade
let tradeError = null;
try {
console.log(`\n== 3) Trade: 3x ${MARKET} long with $20 margin (signed by the agent)`);
await hub.refreshPrices();
const pv = hub.preview(MARKET, { side: "buy", usd: 20, leverage: 3 });
console.log(`   preview: buy ${pv.size} ${MARKET} @ ≤${pv.price} | notional ${usd(pv.notionalUsd)} | fees: Hyperliquid ${usd(pv.fees.hyperliquidUsd)} + builder ${usd(pv.fees.builderUsd)}`);
const open = await hub.placeOrder(agentAcct, MARKET, { side: "buy", usd: 20, leverage: 3 });
console.log(`   result: ${JSON.stringify(open.statuses)}`);
if (open.statuses[0].status === "filled") {
  const pf = await hub.portfolio(trader.address);
  const p = pf.perps.find((x) => x.symbol === MARKET);
  console.log(`   ✔ position: ${p.side} ${p.size} ${MARKET} @ ${p.entryPx} | ${p.leverage}x ${p.marginMode} | liq ${p.liquidationPx?.toFixed(2)} | uPnL ${usd(p.unrealizedPnl)}`);
  const close = await hub.closePosition(agentAcct, trader.address, MARKET);
  console.log(`   close: ${JSON.stringify(close.statuses)}`);
  const after = await hub.portfolio(trader.address);
  console.log(`   ✔ open perp positions now: ${after.perps.length} | account value ${usd(after.perpAccountValue)}`);
} else {
  console.log("   ✖ open order did not fill; skipping close");
}
} catch (e) {
  tradeError = e;
  console.log(`   ✖ trade step failed: ${e.message.split("\n")[0]}`);
}

// ---------------------------------------------------------------- 4. withdraw
// Always runs: bring everything back so no test funds are stranded in a throwaway account.
const all = Math.floor((await hlBal()) * 100) / 100;
console.log(`\n== 4) Withdraw everything (${usd(all)}) back to Elysium through the bridge`);
const before = await read(USDC, erc20, "balanceOf", [trader.address]);
await new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet: trader }).usdSend({ destination: INVENTORY, amount: all.toFixed(2) });
const paid = await poll("Elysium payout", async () => {
  const b = await read(USDC, erc20, "balanceOf", [trader.address]);
  return b > before ? b - before : null;
});
console.log(`   ✔ ${formatUnits(paid.v, 6)} tUSDC on Elysium after ${paid.secs}s`);
console.log(`\n   left on Hyperliquid: ${usd(await hlBal())}`);
console.log(tradeError ? "\nJOURNEY FINISHED WITH A TRADE ERROR (funds returned)" : "\nFULL JOURNEY OK");
