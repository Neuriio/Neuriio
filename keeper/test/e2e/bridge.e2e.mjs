// End-to-end: real FastBridge + PropAMM on a local chain, real BridgeChain adapter, simulated
// HyperCore ledger. Run via script/e2e-bridge.sh (deploys everything first).
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BridgeChain, bridgeAbi } from "../../src/bridge/chain.mjs";
import { SimHyperCore } from "../../src/bridge/hl-sim.mjs";
import { Relayer } from "../../src/bridge/relayer.mjs";
import { MemoryStore } from "../../src/store.mjs";
import { strToUsdc } from "../../src/bridge/units.mjs";

const { RPC_URL, BRIDGE, USDC, HYPE, RELAYER_KEY, ALICE_KEY } = process.env;
const transport = http(RPC_URL);
const pub = createPublicClient({ transport });
const chainDef = { id: await pub.getChainId(), name: "local", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const relayerWallet = createWalletClient({ account: privateKeyToAccount(RELAYER_KEY), transport, chain: chainDef });
const alice = createWalletClient({ account: privateKeyToAccount(ALICE_KEY), transport, chain: chainDef });
const ALICE = alice.account.address;
const BOB = "0x000000000000000000000000000000000000b0b0";
const HL_US = "0x00000000000000000000000000000000000c0de0";

const erc20 = parseAbi([
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const depositAbi = parseAbi(["function deposit(address token, uint256 amountIn, uint256 minUsdcOut, address hlRecipient, uint256 deadline) returns (uint256)"]);

async function send(wallet, address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `${functionName} failed`);
}
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const usd = (u) => formatUnits(u, 6);

const sim = new SimHyperCore();
sim.fund(HL_US, "20000");
const relayer = new Relayer({
  chain: new BridgeChain({ pub, wallet: relayerWallet, chain: chainDef, address: BRIDGE }),
  hl: sim.accountView(HL_US),
  store: new MemoryStore(),
  log: (e) => console.log("  relayer:", JSON.stringify(e)),
  cfg: { refundDelayMs: 3_600_000, refundMarginMs: 600_000, resendAfterMs: 30_000, creditBuffer: strToUsdc("100"), creditStep: strToUsdc("50") },
});

console.log("1) relayer boots: credit set from HyperCore inventory");
await relayer.tick();
assert.equal(await read(BRIDGE, bridgeAbi, "credit"), strToUsdc("19900"));

console.log("2) Alice deposits 1,000 USDC and 5 HYPE (HYPE credited to Bob's HyperCore account)");
await send(alice, USDC, erc20, "mint", [ALICE, parseUnits("5000", 6)]);
await send(alice, HYPE, erc20, "mint", [ALICE, parseUnits("100", 18)]);
await send(alice, USDC, erc20, "approve", [BRIDGE, 2n ** 255n]);
await send(alice, HYPE, erc20, "approve", [BRIDGE, 2n ** 255n]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
await send(alice, BRIDGE, depositAbi, "deposit", [USDC, parseUnits("1000", 6), 0n, ALICE, deadline]);
await send(alice, BRIDGE, depositAbi, "deposit", [HYPE, parseUnits("5", 18), 0n, BOB, deadline]);
const d2 = await read(BRIDGE, bridgeAbi, "deposits", [2n]);
console.log(`   HYPE deposit converted via PropAMM -> ${usd(d2[4])} USDC for Bob (fee ${usd(d2[5])})`);

console.log("3) relayer credits both on HyperCore and marks them fulfilled");
await relayer.tick();
assert.equal(sim.balanceOf(ALICE), strToUsdc("999.5"));
assert.equal(sim.balanceOf(BOB), d2[4]);
assert.equal((await read(BRIDGE, bridgeAbi, "deposits", [1n]))[2], 2);
assert.equal((await read(BRIDGE, bridgeAbi, "deposits", [2n]))[2], 2);
console.log(`   HyperCore balances: Alice ${usd(sim.balanceOf(ALICE))}, Bob ${usd(sim.balanceOf(BOB))}, us ${usd(sim.balanceOf(HL_US))}`);

console.log("4) Alice withdraws 300 USDC: sends to us on HyperCore, gets paid on Elysium");
const before = await read(USDC, erc20, "balanceOf", [ALICE]);
const { hash } = sim.transfer(ALICE, HL_US, "300");
await relayer.tick();
await relayer.tick(); // second tick must not pay again
const after = await read(USDC, erc20, "balanceOf", [ALICE]);
assert.equal(after - before, strToUsdc("299.5"));
assert.equal(await read(BRIDGE, bridgeAbi, "paidOut", [hash]), true);
console.log(`   Alice received ${usd(after - before)} USDC on Elysium (fee 0.5)`);

const credit = await read(BRIDGE, bridgeAbi, "credit");
console.log(`5) final credit ${usd(credit)} = HyperCore inventory ${usd(sim.balanceOf(HL_US))} - 100 buffer`);
assert.equal(credit, sim.balanceOf(HL_US) - strToUsdc("100"));
console.log("E2E OK");
