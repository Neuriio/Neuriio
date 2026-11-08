// Partner fees (src/fees/partner.mjs): NeuriioSwap fees on listed outside tokens -> 40% to NeuriioPartnerStaking, paid in USDC
// from the fee wallet's float at the Hyperliquid price. The first tests are pure; the rest run on a local chain (anvil) against
// the real NeuriioPartnerStaking, with NeuriioSwap's events mocked (test/mocks/MockNeuriioSwapFees.sol). Needs `forge build`.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { memoryLedger } from "../src/fees/ledger.mjs";
import { feeToUsdc, hyperliquidHypeUsd, makePartnerRouter } from "../src/fees/partner.mjs";
import { applyEvent, balancesAt, emptyTally, makeNeuriioTally, MAX_REWARDS, memoryNeuriioStore, tallyFromJson, tallyToJson } from "../src/fees/neuriio.mjs";

const HYPE = 10n ** 18n;
const NATIVE = "0x0000000000000000000000000000000000000000";

test("value: a HYPE fee at the HYPE price, in USDC base units", () => {
  assert.equal(feeToUsdc(HYPE, 18, 77.71), 77_710_000n);
  assert.equal(feeToUsdc(5n * 10n ** 14n, 18, 77.71), 38_855n); // 0.0005 HYPE = $0.038855
  assert.equal(feeToUsdc(2_500_000n, 6, 1), 2_500_000n);
});

test("price: Hyperliquid's HYPE mid, and nothing odd gets through", async () => {
  const fake = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
  assert.equal(await hyperliquidHypeUsd(fake({ HYPE: "77.71" })), 77.71);
  for (const bad of [{}, { HYPE: "0" }, { HYPE: "abc" }, { HYPE: "1e9" }]) await assert.rejects(hyperliquidHypeUsd(fake(bad)));
  await assert.rejects(hyperliquidHypeUsd(fake({ HYPE: "77" }, false)));
});

// Neuriio for partner stakers, the pure part
const NEURIIO = 1_000_000n;
const ev = (kind, time, amount, over = {}) => ({ kind, time, amount, token: "t", user: "u", fromFeeWallet: true, ...over });
const mintedOf = (s, now, user = "u") => balancesAt(s, now).find((b) => b.wallet === user)?.minted ?? 0n;

test("neuriio: partner stakers earn 100 per $1 too, and the same token in both contracts never mixes its pools", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 10n ** 18n)); // u in our contract
  applyEvent(s, ev("Staked", 100n, 10n ** 18n, { user: "v", partner: true })); // v in partner staking, same token
  applyEvent(s, ev("RewardAdded", 100n, 1_000_000n, { partner: true })); // $1 into the partner pool only
  assert.equal(mintedOf(s, 100_000n), 0n, "our contract's staker gets none of the partner pool");
  const v = mintedOf(s, 100_000n, "v");
  assert.ok(v <= 100n * NEURIIO && v >= 100n * NEURIIO - 100n, `${v}`);
});

test("neuriio: a wallet staking one token in both contracts gets one balance, the sum", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 10n ** 18n));
  applyEvent(s, ev("Staked", 100n, 10n ** 18n, { partner: true }));
  applyEvent(s, ev("RewardAdded", 100n, 1_000_000n));
  applyEvent(s, ev("RewardAdded", 100n, 2_000_000n, { partner: true }));
  const rows = balancesAt(s, 100_000n).filter((b) => b.wallet === "u");
  assert.equal(rows.length, 1);
  assert.ok(rows[0].minted <= 300n * NEURIIO && rows[0].minted >= 300n * NEURIIO - 200n, `${rows[0].minted}`);
});

test("neuriio: the 1B cap is shared by both contracts", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 10n ** 18n));
  applyEvent(s, ev("Staked", 100n, 10n ** 18n, { partner: true }));
  applyEvent(s, ev("RewardAdded", 100n, MAX_REWARDS - 1_000_000n));
  applyEvent(s, ev("RewardAdded", 200n, 9_000_000n, { partner: true }));
  assert.equal(s.rewards, MAX_REWARDS);
});

test("neuriio: a tally with partner pools survives being saved and loaded", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 10n ** 18n, { partner: true }));
  applyEvent(s, ev("RewardAdded", 100n, 1_000_000n, { partner: true }));
  assert.deepEqual(tallyFromJson(JSON.parse(JSON.stringify(tallyToJson(s)))), s);
});

// ------------------------------------------------------------------ on a local chain

const artifact = (file, name) => {
  const a = JSON.parse(readFileSync(new URL(`../../out/${file}/${name}.json`, import.meta.url)));
  return { abi: a.abi, bytecode: a.bytecode.object };
};
const PORT = 18647;
const URL_ = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [URL_] } } });
const pub = createPublicClient({ chain, transport: http(URL_), pollingInterval: 50 });
const tester = createTestClient({ chain, mode: "anvil", transport: http(URL_) }).extend(publicActions);
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const deployer = createWalletClient({ chain, transport: http(URL_), account: privateKeyToAccount(ANVIL_KEY) });

let anvil, w, snapshot;
const send = async (client, address, abi, functionName, args = []) => {
  const hash = await client.writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", functionName);
  return r;
};
const deploy = async (a, args = []) => {
  const hash = await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
};
const person = async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  await tester.setBalance({ address: account.address, value: 10n ** 20n });
  return createWalletClient({ chain, transport: http(URL_), account });
};

before(async () => {
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; ; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const tokenA = artifact("NeuriioLauncher.t.sol", "TestToken");
  const stakingA = artifact("NeuriioPartnerStaking.sol", "NeuriioPartnerStaking");
  const swapA = artifact("MockNeuriioSwapFees.sol", "MockNeuriioSwapFees");
  w = { tokenAbi: tokenA.abi, stakingAbi: stakingA.abi, swapAbi: swapA.abi };
  w.feeWallet = await person();
  w.usdc = await deploy(tokenA);
  w.whype = await deploy(tokenA);
  w.kntq = await deploy(tokenA);
  w.a = await deploy(tokenA); // outside tokens
  w.b = await deploy(tokenA);
  w.unlisted = await deploy(tokenA);
  w.staking = await deploy(stakingA, [w.usdc, deployer.account.address]);
  for (const t of [w.a, w.b]) await send(deployer, w.staking, stakingA.abi, "setListed", [t, true]);
  w.swap = await deploy(swapA, [w.feeWallet.account.address]);
  w.otherSwap = await deploy(swapA, [deployer.account.address]); // pays its fee to someone else
  w.staker = await person();
  for (const t of [w.a, w.b]) {
    await send(deployer, t, tokenA.abi, "mint", [w.staker.account.address, 10n ** 24n]);
    await send(w.staker, t, tokenA.abi, "approve", [w.staking, 2n ** 256n - 1n]);
  }
  w.trader = await person();
  snapshot = await tester.snapshot();
});

after(() => anvil?.kill());

let ledger, logs, startBlock, reserved, price;
beforeEach(async () => {
  await tester.revert({ id: snapshot });
  snapshot = await tester.snapshot();
  ledger = memoryLedger();
  logs = [];
  reserved = 0n;
  price = 80; // USD per HYPE
  startBlock = await pub.getBlockNumber({ cacheTime: 0 });
  await float(1_000_000_000n); // $1,000 of USDC float in the fee wallet
});

const float = (amount) => send(deployer, w.usdc, w.tokenAbi, "mint", [w.feeWallet.account.address, amount]);
const router = (over = {}, broadcast) =>
  makePartnerRouter({
    pub,
    wallet: w.feeWallet,
    ledger,
    broadcast,
    log: (ev, o) => logs.push({ ev, ...o }),
    cfg: {
      usdc: w.usdc,
      whype: w.whype,
      staking: w.staking,
      swaps: [w.swap],
      tokens: [w.a, w.b],
      fromBlock: startBlock,
      confirmations: 0,
      maxRange: 5000,
      minPayout: 1n,
      floatWarn: 0n,
      send: true,
      receiptTimeoutMs: 20_000,
      hypeUsd: async () => price,
      reserve: async () => reserved,
      ...over,
    },
  });
const buy = (token, quote, fee, swap = w.swap) => send(w.trader, swap, w.swapAbi, "buy", [token, quote, fee]);
const sell = (token, quote, fee) => send(w.trader, w.swap, w.swapAbi, "sell", [token, quote, fee]);
const stake = (token, amount = HYPE) => send(w.staker, w.staking, w.stakingAbi, "stake", [token, amount]);
const usdcOf = (who) => pub.readContract({ address: w.usdc, abi: w.tokenAbi, functionName: "balanceOf", args: [who] });
const dripping = (token) => pub.readContract({ address: w.staking, abi: w.stakingAbi, functionName: "dripping", args: [token] });
const closeTo = (a, b) => assert.ok(a === b || a === b - 1n || a === b + 1n, `${a} vs ${b}`);
const run = async (r = router()) => {
  await r.scan();
  await r.pay();
};
const me = () => w.feeWallet.account.address;

test("chain: 40% of each token's HYPE fees, valued at the HYPE price, paid from the float to its stakers", async () => {
  await stake(w.a);
  await stake(w.b);
  await buy(w.a, NATIVE, 3n * HYPE); // $240 of fees
  await sell(w.a, w.whype, HYPE); // $80 (WHYPE pairs pay the fee in HYPE too)
  await buy(w.b, NATIVE, HYPE / 2n); // $40
  await run();

  closeTo(await dripping(w.a), 128_000_000n); // 40% of $320
  closeTo(await dripping(w.b), 16_000_000n); // 40% of $40
  assert.equal(await usdcOf(me()), 1_000_000_000n - 144_000_000n);
  assert.equal(ledger.runs[0].status, "done");
});

test("chain: an unlisted token's fees aren't recorded at all", async () => {
  await stake(w.a);
  await buy(w.unlisted, NATIVE, HYPE);
  await run();
  assert.equal(ledger.receipts.size, 0);
  assert.equal(await usdcOf(me()), 1_000_000_000n);
});

test("chain: a NeuriioSwap whose fee wallet isn't ours is ignored", async () => {
  await stake(w.a);
  await buy(w.a, NATIVE, HYPE, w.otherSwap);
  await run(router({ swaps: [w.swap, w.otherSwap] }));
  assert.equal(ledger.receipts.size, 0);
  assert.ok(logs.some((l) => l.ev === "SWAP_FEE_WALLET_IS_NOT_US"));
});

test("chain: a USDC-pair fee counts 1:1; a quote it can't price is held, never paid", async () => {
  await stake(w.a);
  await buy(w.a, w.usdc, 10_000_000n); // $10
  await buy(w.a, w.kntq, 10n ** 21n); // KNTQ: no price
  await run();
  closeTo(await dripping(w.a), 4_000_000n);
  const held = [...ledger.receipts.values()].filter((r) => !r.token);
  assert.equal(held.length, 1);
  assert.match(held[0].reason, /unpriced_quote/);
  assert.equal(held[0].runId, null);
});

test("chain: running again pays nothing twice", async () => {
  await stake(w.a);
  await buy(w.a, NATIVE, HYPE);
  await run();
  const after1 = await usdcOf(me());
  await run();
  await run();
  assert.equal(await usdcOf(me()), after1);
  assert.equal(ledger.runs.length, 1);
});

test("chain: a token with no stakers sends nothing: the float keeps it, and the fee isn't paid later either", async () => {
  await buy(w.a, NATIVE, HYPE);
  await run();
  assert.equal(await usdcOf(me()), 1_000_000_000n);
  await stake(w.a);
  await run();
  assert.equal(await usdcOf(me()), 1_000_000_000n, "an old fee isn't paid to someone who staked after");
});

test("chain: a delisted token's share stays in the float", async () => {
  await stake(w.a);
  await buy(w.a, NATIVE, HYPE);
  await send(deployer, w.staking, w.stakingAbi, "setListed", [w.a, false]);
  await run();
  assert.equal(await usdcOf(me()), 1_000_000_000n);
});

test("chain: the float never spends USDC the Ascend fee router still owes", async () => {
  await stake(w.a);
  await buy(w.a, NATIVE, 10n * HYPE); // 40% of $800 = $320
  reserved = 800_000_000n; // $1,000 float, $800 owed elsewhere: $200 free
  await run();
  assert.equal(await usdcOf(me()), 1_000_000_000n);
  assert.ok(logs.some((l) => l.ev === "PARTNER_FLOAT_LOW"));
  assert.equal(ledger.runs.length, 0, "nothing claimed: it pays once the float is topped up");

  await float(200_000_000n);
  await run();
  closeTo(await dripping(w.a), 320_000_000n);
});

test("chain: the price is the one when the fee was recorded", async () => {
  await stake(w.a);
  await buy(w.a, NATIVE, HYPE);
  await router({ send: false }).scan();
  price = 1000; // HYPE moons before the payout
  await run();
  closeTo(await dripping(w.a), 32_000_000n); // 40% of $80, not $1,000
});

test("chain: without SEND it only logs the plan", async () => {
  await stake(w.a);
  await buy(w.a, NATIVE, HYPE);
  await run(router({ send: false }));
  assert.equal(await usdcOf(me()), 1_000_000_000n);
  assert.ok(logs.some((l) => l.ev === "partner_dry_run"));
  assert.equal(ledger.runs.length, 0);
});

test("chain: crashing after a send doesn't pay twice", async () => {
  await stake(w.a);
  await buy(w.a, NATIVE, HYPE);
  let sent = 0;
  const crashAfter = async (raw) => {
    const hash = await pub.sendRawTransaction({ serializedTransaction: raw });
    if (++sent === 2) throw new Error("crash after the reward was sent");
    return hash;
  };
  await router({}, crashAfter).scan();
  await router({}, crashAfter).pay().catch(() => {});
  await router().pay(); // a restart finishes the open run
  closeTo(await dripping(w.a), 32_000_000n);
  assert.equal(await usdcOf(me()), 1_000_000_000n - 32_000_000n);
  assert.equal(ledger.runs[0].status, "done");
});

test("chain: Neuriio for partner stakers is 100 x what the contract says they earned; paying your own pool earns none", async () => {
  await stake(w.a);
  await buy(w.a, NATIVE, HYPE); // $80 of fees -> $32 to a's stakers
  await run();
  // someone pays USDC into b's pool themselves, stakes and claims it back: no Neuriio for that
  const gamer = await person();
  await send(deployer, w.usdc, w.tokenAbi, "mint", [gamer.account.address, 50_000_000n]);
  await send(deployer, w.b, w.tokenAbi, "mint", [gamer.account.address, HYPE]);
  await send(gamer, w.usdc, w.tokenAbi, "approve", [w.staking, 2n ** 256n - 1n]);
  await send(gamer, w.b, w.tokenAbi, "approve", [w.staking, 2n ** 256n - 1n]);
  await send(gamer, w.staking, w.stakingAbi, "stake", [w.b, HYPE]);
  await send(gamer, w.staking, w.stakingAbi, "notifyReward", [w.b, 50_000_000n]);
  await tester.increaseTime({ seconds: 3600 });
  await tester.mine({ blocks: 1 });

  const store = memoryNeuriioStore();
  const notOurs = privateKeyToAccount(generatePrivateKey()).address; // the original contract: nothing there in this test
  await makeNeuriioTally({ pub, store, cfg: { staking: notOurs, partnerStaking: w.staking, feeWallet: me(), fromBlock: startBlock, confirmations: 0, maxRange: 5000 } }).scan();

  const earned = await pub.readContract({ address: w.staking, abi: w.stakingAbi, functionName: "earned", args: [w.staker.account.address, w.a] });
  assert.equal(store.balances.get(`${w.staker.account.address.toLowerCase()}:${w.a.toLowerCase()}`), earned * 100n);
  assert.equal(store.balances.get(`${gamer.account.address.toLowerCase()}:${w.b.toLowerCase()}`), undefined);
});
