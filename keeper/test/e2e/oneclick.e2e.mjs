// End-to-end one-click on a local chain: a brand-new wallet with ZERO gas delegates to
// NeuriioAccount (EIP-7702), adds a device session key, and buys with tHYPE, all sponsored.
// Real contracts, real Sponsor + OneClick code; HyperCore ledger simulated.
// Run via script/e2e-oneclick.sh (deploys everything first).
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BridgeChain, bridgeAbi } from "../../src/bridge/chain.mjs";
import { SimHyperCore } from "../../src/bridge/hl-sim.mjs";
import { Relayer } from "../../src/bridge/relayer.mjs";
import { MemoryStore } from "../../src/store.mjs";
import { strToUsdc } from "../../src/bridge/units.mjs";
import { accountAbi, isDelegatedTo, prepareSetup, signBuy } from "../../src/oneclick/account.mjs";
import { Sponsor } from "../../src/oneclick/sponsor.mjs";
import { fromWire, toWire } from "../../src/oneclick/wire.mjs";

const { RPC_URL, BRIDGE, USDC, HYPE, DELEGATE, RELAYER_KEY, SPONSOR_KEY } = process.env;
const transport = http(RPC_URL);
const pub = createPublicClient({ transport });
const chainDef = { id: await pub.getChainId(), name: "local", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const relayerWallet = createWalletClient({ account: privateKeyToAccount(RELAYER_KEY), transport, chain: chainDef });
const erc20 = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const send = async (address, abi, functionName, args) => {
  const r = await pub.waitForTransactionReceipt({ hash: await relayerWallet.writeContract({ address, abi, functionName, args }) });
  assert.equal(r.status, "success");
};
const wire = (x) => fromWire(toWire(x)); // exactly what crosses HTTP

// HyperCore (simulated) + relayer
const HL_US = "0x00000000000000000000000000000000000c0de0";
const sim = new SimHyperCore();
sim.fund(HL_US, "20000");
const relayer = new Relayer({
  chain: new BridgeChain({ pub, wallet: relayerWallet, chain: chainDef, address: BRIDGE }),
  hl: sim.accountView(HL_US),
  store: new MemoryStore(),
  log: () => {},
  cfg: { refundDelayMs: 3_600_000, refundMarginMs: 600_000, resendAfterMs: 30_000, creditBuffer: strToUsdc("100"), creditStep: strToUsdc("50") },
});
await relayer.tick();

const sponsorSigner = privateKeyToAccount(SPONSOR_KEY);
const sponsor = await new Sponsor({ pub, signer: sponsorSigner, delegate: DELEGATE, log: (e) => console.log("  sponsor:", JSON.stringify(e)) }).init();

// A brand-new user: no HYPE for gas, only tokens
const main = privateKeyToAccount(generatePrivateKey());
await send(HYPE, erc20, "mint", [main.address, parseUnits("10", 18)]);
await send(USDC, erc20, "mint", [main.address, parseUnits("500", 6)]);
assert.equal(await pub.getBalance({ address: main.address }), 0n);
const sponsorBal0 = await pub.getBalance({ address: sponsorSigner.address });

console.log("1) setup: wallet signs 7702 authorization + session (caps $200/buy, $300/day); sponsor submits");
const { deviceKey, request } = await prepareSetup({ main, pub, delegate: DELEGATE, caps: { maxPerBuy: 200_000_000n, maxPerDay: 300_000_000n } });
await sponsor.setup(wire(request));
assert.ok(await isDelegatedTo(pub, main.address, DELEGATE), "wallet delegated");
const device = privateKeyToAccount(deviceKey);
const s = await read(main.address, accountAbi, "session", [device.address]);
assert.equal(s.maxPerBuy, 200_000_000n);
console.log(`   ✔ wallet ${main.address} now runs NeuriioAccount; device key ${device.address} registered`);

console.log("2) one-click buy: device signs, sponsor submits, no wallet prompt, no gas");
const hypeIn = parseUnits("2", 18);
const signed = await signBuy({ device, wallet: main.address, chainId: chainDef.id, order: { token: HYPE, amountIn: hypeIn } });
const { depositId } = await sponsor.buy(wire(signed));
const d = await read(BRIDGE, bridgeAbi, "deposits", [depositId]);
assert.equal(d[0], main.address, "refunds belong to the wallet");
assert.equal(d[3], main.address, "credited to the wallet's own HyperCore account");
console.log(`   ✔ 2 tHYPE -> ${formatUnits(d[4] + d[5], 6)} USDC deposit #${depositId}`);

await relayer.tick();
assert.equal((await read(BRIDGE, bridgeAbi, "deposits", [depositId]))[2], 2, "fulfilled");
assert.equal(sim.balanceOf(main.address), d[4]);
console.log(`   ✔ relayer credited ${formatUnits(sim.balanceOf(main.address), 6)} USDC on HyperCore (simulated)`);

console.log("3) guards: replay, per-buy cap, daily cap, unknown key");
await assert.rejects(sponsor.buy(wire(signed)), /NonceUsed/);
const big = await signBuy({ device, wallet: main.address, chainId: chainDef.id, order: { token: USDC, amountIn: 250_000_000n } });
await assert.rejects(sponsor.buy(wire(big)), /OverPerBuyCap/);
// $300/day: after the HYPE buy, two more $200 buys can't both fit
const b2 = () => signBuy({ device, wallet: main.address, chainId: chainDef.id, order: { token: USDC, amountIn: 200_000_000n } });
await sponsor.buy(wire(await b2())).catch((e) => assert.match(e.message, /OverDailyCap/));
await assert.rejects(sponsor.buy(wire(await b2())), /OverDailyCap/);
const thief = privateKeyToAccount(generatePrivateKey());
const stolen = await signBuy({ device: thief, wallet: main.address, chainId: chainDef.id, order: { token: USDC, amountIn: 20_000_000n } });
await assert.rejects(sponsor.buy(wire(stolen)), /InvalidSession/);
console.log("   ✔ all refused at simulation (no gas spent)");

console.log("4) user never paid gas");
assert.equal(await pub.getBalance({ address: main.address }), 0n);
const spent = sponsorBal0 - (await pub.getBalance({ address: sponsorSigner.address }));
console.log(`   ✔ wallet HYPE balance 0; sponsor paid ${formatUnits(spent, 18)} HYPE for setup + buy`);
console.log("\nONE-CLICK E2E OK");
