// One-click on testnet, from a brand-new wallet that never holds HYPE for gas:
//   1. setup:  wallet signs a 7702 authorization + device session (sponsor submits),
//              then creates its HyperCore trade agent (the two one-time approvals)
//   2. buy:    3x BTC perp paid with tHYPE: one click, no prompts, no gas
//   3. buy:    PURR spot paid with tHYPE: USDC auto-moved perps -> spot by the agent
//   4. cleanup: close/sell, move USDC back to perps, withdraw everything to Elysium
// Run via script/oneclick-test.sh. Needs the bots running (relayer + feeder).
import { createPublicClient, createWalletClient, formatUnits, parseAbi, parseUnits } from "viem";
import { makeTransport } from "../../src/rpc.mjs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { TradeHub } from "../../src/trade/hub.mjs";
import { OneClick } from "../../src/oneclick/oneclick.mjs";
import { prepareSetup } from "../../src/oneclick/account.mjs";
import { Sponsor } from "../../src/oneclick/sponsor.mjs";
import { fromWire, toWire } from "../../src/oneclick/wire.mjs";

const { RPC_URL, BRIDGE, HYPE, USDC, DELEGATE, SPONSOR_KEY, INVENTORY } = process.env;
const PERP = process.env.PERP ?? "BTC"; // testnet HYPE perp book is one-sided
const SPOT = process.env.SPOT ?? "PURR/USDC";
const transport = makeTransport(`${RPC_URL},https://elysium-testnet-rpc.hypedexer.com/`, { name: "oneclick-test", statsEveryMs: 0 });
const pub = createPublicClient({ transport });
const chain = { id: 99801, name: "elysium-testnet", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const sponsorSigner = privateKeyToAccount(SPONSOR_KEY);
const sponsorWallet = createWalletClient({ account: sponsorSigner, transport, chain });
const erc20 = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const usd = (x) => `$${Number(x).toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wire = (x) => fromWire(toWire(x)); // exactly what crosses HTTP to the sponsor service
const poll = async (label, fn, timeoutMs = 90_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, secs: ((Date.now() - t0) / 1000).toFixed(1) };
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(1000);
  }
};

const main = privateKeyToAccount(generatePrivateKey()); // the user's wallet: tokens only, zero HYPE
const sponsor = await new Sponsor({ pub, signer: sponsorSigner, delegate: DELEGATE, log: () => {} }).init();
const hub = await new TradeHub({ testnet: true }).init();
const oc = await new OneClick({ pub, hub, sponsor, bridge: BRIDGE, inventory: INVENTORY }).init();
console.log(`user wallet ${main.address} (0 HYPE)\n`);

// test tokens (tHYPE has a public mint; the sponsor pays that gas too)
const h = await sponsorWallet.writeContract({ address: HYPE, abi: erc20, functionName: "mint", args: [main.address, parseUnits("3", 18)] });
await pub.waitForTransactionReceipt({ hash: h });

// ---------------------------------------------------------------- 1. setup
console.log("== 1) One-time setup (two approvals, no gas)");
const { deviceKey, request } = await prepareSetup({ main, pub, delegate: DELEGATE, caps: { maxPerBuy: 500_000_000n, maxPerDay: 1_000_000_000n } });
await sponsor.setup(wire(request));
const device = privateKeyToAccount(deviceKey);
console.log(`   ✔ approval 1: wallet delegated to NeuriioAccount, device key ${device.address} ($500/buy, $1,000/day, 30 days)`);
// A brand-new HyperCore account can't approve anything before its first deposit, so the app
// collects this signature now and submits it right after the first bridge-in lands.
const agentInfo = await hub.signAgentApproval(main, "neuriio-1click");
const agent = privateKeyToAccount(agentInfo.key);
console.log(`   ✔ approval 2: HyperCore trade agent ${agent.address} (signed now, submitted after the first deposit)`);

const stages = (label) => (stage, info) => {
  const extra = stage === "bridging" ? ` deposit #${info.depositId}` : "";
  console.log(`   … ${label}: ${stage}${extra}`);
};

let error = null;
try {
  // -------------------------------------------------------------- 2. perp
  console.log(`\n== 2) One click: 3x ${PERP} long, pay with 1.5 tHYPE`);
  const perpIn = parseUnits("1.5", 18);
  const q1 = await oc.quote({ user: main.address, payToken: HYPE, amountIn: perpIn, market: PERP, leverage: 3, slippageBps: 100 });
  console.log(`   button: "${PERP} · est. ${q1.est.amount}" | 1.5 tHYPE -> ${usd(q1.usdc)} USDC | HL activation ${usd(q1.fees.hyperliquidActivationUsd)} | margin ${usd(q1.orderUsd)} (${usd(q1.est.notionalUsd)} notional)`);
  const t1 = Date.now();
  const r1 = await oc.buy({ user: main.address, device, agent, agentApproval: agentInfo.approval, payToken: HYPE, amountIn: perpIn, market: PERP, leverage: 3, slippageBps: 100, onStage: stages(PERP) });
  console.log(`   ✔ ${JSON.stringify(r1.fill)} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // -------------------------------------------------------------- 3. spot
  console.log(`\n== 3) One click: ${SPOT} spot, pay with 1 tHYPE`);
  const spotIn = parseUnits("1", 18);
  const q2 = await oc.quote({ user: main.address, payToken: HYPE, amountIn: spotIn, market: SPOT, slippageBps: 100 });
  console.log(`   button: "${SPOT} · est. ${q2.est.amount}" | spend ${usd(q2.orderUsd)}`);
  const t2 = Date.now();
  const r2 = await oc.buy({ user: main.address, device, agent, payToken: HYPE, amountIn: spotIn, market: SPOT, slippageBps: 100, onStage: stages(SPOT) });
  console.log(`   ✔ ${JSON.stringify(r2.fill)} | USDC moved perps->spot by agent: ${JSON.stringify(r2.funded)} | ${((Date.now() - t2) / 1000).toFixed(1)}s`);
} catch (e) {
  error = e;
  console.log(`   ✖ ${e.message.split("\n")[0]}`);
}

// ---------------------------------------------------------------- 4. cleanup
console.log("\n== 4) Cleanup: close, sell, withdraw everything back to Elysium");
try {
  await hub.closePosition(agent, main.address, PERP);
  console.log(`   closed ${PERP}`);
} catch (e) {
  console.log(`   (no ${PERP} position: ${e.message.split("\n")[0]})`);
}
const spotMarket = hub.market(SPOT);
const bal = (await hub.info.spotClearinghouseState({ user: main.address })).balances.find((b) => b.coin === spotMarket.base);
if (bal && Number(bal.total) > 0) {
  await hub.refreshPrices();
  const r = await hub.placeOrder(agent, SPOT, { side: "sell", size: Number(bal.total), slippageBps: 200 });
  console.log(`   sold ${bal.total} ${spotMarket.base}: ${JSON.stringify(r.statuses)}`);
}
await sleep(1500);
const spotUsdc = (await hub.usdcBalances(main.address)).spot;
if (spotUsdc >= 0.01) {
  const amount = (Math.floor(spotUsdc * 100) / 100).toFixed(2);
  await new ExchangeClient({ transport: hub.transport, wallet: agent }).agentSendAsset({ destination: main.address, sourceDex: "spot", destinationDex: "", token: hub.usdcToken, amount });
  console.log(`   agent moved ${usd(amount)} spot -> perps`);
}
await sleep(1500);
const all = Math.floor((await hub.usdcBalances(main.address)).perp * 100) / 100;
const before = await read(USDC, erc20, "balanceOf", [main.address]);
if (all >= 0.01) {
  await new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet: main }).usdSend({ destination: INVENTORY, amount: all.toFixed(2) });
  const paid = await poll("Elysium payout", async () => {
    const b = await read(USDC, erc20, "balanceOf", [main.address]);
    return b > before ? b - before : null;
  });
  console.log(`   ✔ ${formatUnits(paid.v, 6)} tUSDC back on Elysium after ${paid.secs}s`);
}
console.log(`   wallet HYPE balance: ${formatUnits(await pub.getBalance({ address: main.address }), 18)} (never needed gas)`);
console.log(error ? "\nONE-CLICK TEST FINISHED WITH AN ERROR (funds returned)" : "\nONE-CLICK LIVE OK");
process.exit(error ? 1 : 0);
