// Live checks for the trade hub against real Hyperliquid. No funds needed.
//   node test/live/trade.live.mjs
// 1. Mainnet, read-only: catalog, order previews at live prices, a public account's portfolio.
// 2. Testnet, signed: a fresh unfunded wallet sends real signed actions. HyperCore rejects them for
//    lack of funds, and *how* it rejects them shows the signature and payload were accepted.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TradeHub } from "../../src/trade/hub.mjs";

const BUILDER = { address: "0x000000000000000000000000000000000000b111", fees: { perp: 50, spot: 50, outcome: 0 } };
const HLP = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303"; // Hyperliquid's public HLP vault

console.log("== MAINNET (read-only)");
const main = await new TradeHub({ builder: BUILDER }).init();
const kinds = ["perp", "spot", "outcome"].map((k) => `${k} ${main.catalog.list(k).length}`).join(", ");
console.log(`markets: ${kinds}`);

const show = (label, s) =>
  console.log(
    `  ${label.padEnd(26)} ${s.side} ${s.size} @ ${s.price} | notional $${s.notionalUsd} margin $${s.marginUsd} ${s.leverage}x | fees: HL $${s.fees.hyperliquidUsd} + ours $${s.fees.builderUsd}`,
  );
show("10x HYPE long, $100", main.preview("HYPE", { side: "buy", usd: 100, leverage: 10 }));
show("KNTQ spot buy, $50", main.preview("KNTQ/USDC", { side: "buy", usd: 50 }));
show("BTC 3x short + TP/SL", main.preview("BTC", { side: "sell", usd: 200, leverage: 3, takeProfit: main.market("BTC").mid * 0.95, stopLoss: main.market("BTC").mid * 1.03 }));
const outcome = main.catalog.list("outcome").find((m) => m.mid > 0.05 && m.mid < 0.95);
show(`outcome "${outcome.symbol.slice(0, 20)}"`, main.preview(outcome.coin, { side: "buy", usd: 20 }));

// HLP's master vault holds nothing itself; its child vaults hold the positions
const { relationship } = await main.info.vaultDetails({ vaultAddress: HLP });
let pf;
for (const child of relationship.data.childAddresses) {
  pf = await main.portfolio(child);
  if (pf.perps.length) break;
}
console.log(`  HLP sub-vault portfolio: account $${Math.round(pf.perpAccountValue).toLocaleString()}, ${pf.perps.length} perp positions, uPnL $${Math.round(pf.totals.unrealizedPnl).toLocaleString()}`);
const top = [...pf.perps].sort((a, b) => b.positionValue - a.positionValue)[0];
console.log(`  largest: ${top.side} ${top.size} ${top.symbol} entry ${top.entryPx} mark ${top.markPx} uPnL $${Math.round(top.unrealizedPnl).toLocaleString()} liq ${top.liquidationPx}`);

console.log("\n== TESTNET (signed, unfunded wallet)");
const test = await new TradeHub({ testnet: true, builder: BUILDER }).init();
const user = privateKeyToAccount(generatePrivateKey());
console.log(`  fresh wallet ${user.address}`);
console.log("  onboarding status:", JSON.stringify(await test.onboardingStatus(user.address)));
const attempt = async (label, fn) => {
  try {
    console.log(`  ${label}: accepted`, JSON.stringify(await fn()));
  } catch (e) {
    console.log(`  ${label}: rejected -> ${e.message.split("\n")[0]}`);
  }
};
await attempt("approveBuilderFee", () => test.approveBuilder(user));
await attempt("approveAgent", () => test.createAgent(user));
await attempt("order (10x HYPE)", () => test.placeOrder(user, "HYPE", { side: "buy", usd: 20, leverage: 10 }));
