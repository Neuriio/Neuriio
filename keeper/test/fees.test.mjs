// The fee router. The first tests are pure; the rest run it on a local chain (anvil) against the real NeuriioLauncher and
// NeuriioTokenStaking, with Ascend's fee path mocked (test/mocks/MockAscendFees.sol: per-token escrows paying our builder
// fee with BuilderPaid). Needs `forge build` first.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { planPayout } from "../src/fees/plan.mjs";
import { memoryLedger } from "../src/fees/ledger.mjs";
import { makeFeeRouter } from "../src/fees/router.mjs";
import { applyEvent, balancesAt, emptyTally, makeNeuriioTally, MAX_REWARDS, memoryNeuriioStore, tallyFromJson, tallyToJson } from "../src/fees/neuriio.mjs";

test("plan: 40% per token by what it paid, the rest to treasury", () => {
  const p = planPayout([{ token: "A", amount: 750n }, { token: "B", amount: 250n }], new Map([["A", 1n], ["B", 1n]]));
  assert.deepEqual(p.rewards, [{ token: "A", amount: 300n }, { token: "B", amount: 100n }]);
  assert.equal(p.treasury, 600n);
});

test("plan: a token with no stakers sends its 40% to treasury", () => {
  const p = planPayout([{ token: "A", amount: 750n }, { token: "B", amount: 250n }], new Map([["A", 1n], ["B", 0n]]));
  assert.deepEqual(p.rewards, [{ token: "A", amount: 300n }]);
  assert.equal(p.treasury, 700n);
});

test("plan: always adds up, whatever the rounding", () => {
  for (const a of [1n, 3n, 7n, 999n, 1_000_001n]) {
    const p = planPayout([{ token: "A", amount: a }, { token: "B", amount: a + 1n }], new Map([["A", 1n], ["B", 1n]]));
    assert.equal(p.rewards.reduce((s, r) => s + r.amount, 0n) + p.treasury, p.total);
  }
});

test("plan: nothing to do", () => assert.deepEqual(planPayout([], new Map()), { total: 0n, rewards: [], treasury: 0n }));

// Neuriio, the pure part: amounts in USDC base units and token wei
const ev = (kind, time, amount, over = {}) => ({ kind, time, amount, token: "t", user: "u", fromFeeWallet: true, ...over });
const mintedOf = (s, now, user = "u") => balancesAt(s, now).find((b) => b.wallet === user)?.minted ?? 0n;
const NEURIIO = 1_000_000n;

test("neuriio: 100 for every $1 a staker earns, as it drips", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 10n ** 18n));
  applyEvent(s, ev("RewardAdded", 100n, 1_000_000n));
  assert.equal(mintedOf(s, 100n), 0n);
  const half = mintedOf(s, 1900n);
  assert.ok(half <= 50n * NEURIIO && half >= 50n * NEURIIO - 100n, `${half}`);
  const all = mintedOf(s, 100_000n);
  assert.ok(all <= 100n * NEURIIO && all >= 100n * NEURIIO - 100n, `${all}`);
});

test("neuriio: split by stake, and nothing for not staking", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 3n * 10n ** 18n));
  applyEvent(s, ev("Staked", 100n, 10n ** 18n, { user: "v" }));
  applyEvent(s, ev("RewardAdded", 100n, 4_000_000n));
  const [u, v] = [mintedOf(s, 9999n), mintedOf(s, 9999n, "v")];
  assert.ok(u <= 300n * NEURIIO && u >= 300n * NEURIIO - 400n, `${u}`);
  assert.ok(v <= 100n * NEURIIO && v >= 100n * NEURIIO - 400n, `${v}`);
  assert.equal(mintedOf(s, 9999n, "nobody"), 0n);
});

test("neuriio: paying your own pool earns nothing", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 10n ** 18n));
  applyEvent(s, ev("RewardAdded", 100n, 10n ** 12n, { fromFeeWallet: false }));
  assert.equal(mintedOf(s, 100_000n), 0n);
  assert.equal(s.rewards, 0n);
});

test("neuriio: someone else paying mid-drip doesn't disturb a real reward", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 10n ** 18n));
  applyEvent(s, ev("RewardAdded", 100n, 1_000_000n));
  applyEvent(s, ev("RewardAdded", 1000n, 10n ** 12n, { fromFeeWallet: false }));
  const all = mintedOf(s, 100_000n);
  assert.ok(all <= 100n * NEURIIO && all >= 100n * NEURIIO - 100n, `${all}`);
});

test("neuriio: unstaking keeps what you got and stops the rest", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 10n ** 18n));
  applyEvent(s, ev("RewardAdded", 100n, 3_600_000n));
  applyEvent(s, ev("Unstaked", 1000n, 10n ** 18n));
  const kept = mintedOf(s, 1000n);
  assert.ok(kept <= 90n * 2_500_000n + 1000n, `${kept}`);
  assert.equal(mintedOf(s, 100_000n), kept);
  applyEvent(s, ev("Staked", 2000n, 10n ** 18n, { user: "v" }));
  assert.ok(mintedOf(s, 100_000n, "v") > 0n, "the rest of the drip waited for the next staker");
  assert.equal(mintedOf(s, 100_000n), kept);
});

test("neuriio: stops at 1B", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 10n ** 18n));
  applyEvent(s, ev("RewardAdded", 100n, MAX_REWARDS - 5_000_000n));
  applyEvent(s, ev("RewardAdded", 200n, 9_000_000n));
  assert.equal(s.rewards, MAX_REWARDS);
  applyEvent(s, ev("RewardAdded", 300n, 9_000_000n));
  assert.equal(s.rewards, MAX_REWARDS);
  const all = mintedOf(s, 10n ** 7n);
  assert.ok(all <= 1_000_000_000n * NEURIIO && all >= 1_000_000_000n * NEURIIO - 1000n, `${all}`);
});

test("neuriio: the tally survives being saved and loaded", () => {
  const s = emptyTally();
  applyEvent(s, ev("Staked", 100n, 10n ** 18n));
  applyEvent(s, ev("RewardAdded", 100n, 1_000_000n));
  assert.deepEqual(tallyFromJson(JSON.parse(JSON.stringify(tallyToJson(s)))), s);
});

// ------------------------------------------------------------------ on a local chain

const artifact = (file, name) => {
  const a = JSON.parse(readFileSync(new URL(`../../out/${file}/${name}.json`, import.meta.url)));
  return { abi: a.abi, bytecode: a.bytecode.object };
};
const PORT = 18645;
const URL_ = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [URL_] } } });
const pub = createPublicClient({ chain, transport: http(URL_), pollingInterval: 50 });
const tester = createTestClient({ chain, mode: "anvil", transport: http(URL_) }).extend(publicActions);
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const deployer = createWalletClient({ chain, transport: http(URL_), account: privateKeyToAccount(ANVIL_KEY) });
const signer = privateKeyToAccount(generatePrivateKey());

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
  const usdcA = artifact("NeuriioLauncher.t.sol", "TestToken");
  const launcherA = artifact("NeuriioLauncher.sol", "NeuriioLauncher");
  const stakingA = artifact("NeuriioTokenStaking.sol", "NeuriioTokenStaking");
  const feesA = artifact("MockAscendFees.sol", "MockAscendFees");
  const adapterA = artifact("NeuriioLauncher.t.sol", "MockAdapter");
  const usdc = await deploy(usdcA);
  const launcher = await deploy(launcherA, [deployer.account.address, usdc, signer.address, deployer.account.address]);
  const adapter = await deploy(adapterA, [usdc]);
  await send(deployer, launcher, launcherA.abi, "setAdapter", [adapter]);
  const staking = await deploy(stakingA, [usdc, launcher]);
  const fees = await deploy(feesA, [usdc]);
  w = { usdc, usdcAbi: usdcA.abi, launcher, launcherAbi: launcherA.abi, staking, stakingAbi: stakingA.abi, fees, feesAbi: feesA.abi };
  // the fee wallet is our builder address: every escrow pays it (fixed for all tests; balances reset between them)
  w.feeWallet = await person();

  const launch = async (xId, handle) => {
    const creator = await person();
    const pass = { creator: creator.account.address, xUserId: BigInt(xId), handle, category: 0, profileHash: `0x${"00".repeat(32)}`, launchData: "0x", deadline: 10n ** 12n };
    const signature = await signer.signTypedData({
      domain: { name: "Neuriio Launchpad", version: "1", chainId: 31337, verifyingContract: launcher },
      types: { LaunchPass: [{ name: "creator", type: "address" }, { name: "xUserId", type: "uint64" }, { name: "handle", type: "string" }, { name: "category", type: "uint8" }, { name: "profileHash", type: "bytes32" }, { name: "launchData", type: "bytes" }, { name: "deadline", type: "uint256" }] },
      primaryType: "LaunchPass",
      message: pass,
    });
    await send(creator, launcher, launcherA.abi, "launch", [pass, signature, 0n, 0n]);
    const token = await pub.readContract({ address: launcher, abi: launcherA.abi, functionName: "tokenOfXUser", args: [BigInt(xId)] });
    const { pool: id } = await pub.readContract({ address: launcher, abi: launcherA.abi, functionName: "launchOf", args: [token] });
    return { token, id };
  };
  w.a = await launch(1, "alpha");
  w.b = await launch(2, "bravo");
  for (const t of [w.a, w.b]) {
    await send(deployer, fees, feesA.abi, "register", [t.id, w.feeWallet.account.address]);
    t.escrow = await pub.readContract({ address: fees, abi: feesA.abi, functionName: "escrowOf", args: [t.id] });
  }
  // an escrow on Ascend that names us as builder but isn't one of our launches (anyone can name an approved builder)
  w.foreignPool = `0x${"ab".repeat(32)}`;
  await send(deployer, fees, feesA.abi, "register", [w.foreignPool, w.feeWallet.account.address]);
  w.staker = await person();
  w.trader = await person();
  for (const t of [w.a.token, w.b.token]) {
    await send(deployer, t, usdcA.abi, "mint", [w.staker.account.address, 10n ** 24n]);
    await send(w.staker, t, usdcA.abi, "approve", [staking, 2n ** 256n - 1n]);
  }
  await send(deployer, usdc, usdcA.abi, "mint", [w.trader.account.address, 10n ** 15n]);
  await send(w.trader, usdc, usdcA.abi, "approve", [fees, 2n ** 256n - 1n]);
  snapshot = await tester.snapshot();
});

after(() => anvil?.kill());

let feeWallet, treasury, ledger, logs, startBlock;
beforeEach(async () => {
  await tester.revert({ id: snapshot });
  snapshot = await tester.snapshot();
  feeWallet = w.feeWallet;
  treasury = privateKeyToAccount(generatePrivateKey()).address;
  ledger = memoryLedger();
  logs = [];
  startBlock = await pub.getBlockNumber({ cacheTime: 0 });
});

const router = (over = {}, broadcast) =>
  makeFeeRouter({
    pub,
    wallet: feeWallet,
    ledger,
    broadcast,
    log: (ev, o) => logs.push({ ev, ...o }),
    cfg: { usdc: w.usdc, staking: w.staking, launcher: w.launcher, escrowFactory: w.fees, launchpad: w.fees, treasury, fromBlock: startBlock, confirmations: 0, maxRange: 5000, minPayout: 1n, minSettle: 1n, minClaim: 1n, send: true, receiptTimeoutMs: 20_000, ...over },
  });
/** Trades whose fees leave `fees[i]` of builder fee waiting for `poolIds[i]`. */
const trade = async (poolIds, fees) => {
  for (let i = 0; i < poolIds.length; i++) await send(w.trader, w.fees, w.feesAbi, "trade", [poolIds[i], fees[i]]);
};
/** Ascend's side first (settle + claimBuilder, always with a normal router), then `r` reads what was paid. */
const collectAndScan = async (r) => {
  await router().collect();
  await r.scan();
};
const stake = (token, amount = 10n ** 18n) => send(w.staker, w.staking, w.stakingAbi, "stake", [token, amount]);
const usdcOf = (who) => pub.readContract({ address: w.usdc, abi: w.usdcAbi, functionName: "balanceOf", args: [who] });
const dripping = (token) => pub.readContract({ address: w.staking, abi: w.stakingAbi, functionName: "dripping", args: [token] });
const escrowAbi = artifact("MockAscendFees.sol", "MockCreatorEscrow").abi;
const closeTo = (a, b) => assert.ok(a === b || a === b - 1n || a === b + 1n, `${a} vs ${b}`);

test("chain: fees reach each token's stakers and treasury, and the stakers can claim", async () => {
  await stake(w.a.token);
  await stake(w.b.token);
  await trade([w.a.id], [750_000_000n]);
  await trade([w.b.id], [250_000_000n]);
  const r = router();
  await collectAndScan(r);
  await r.pay();

  closeTo(await dripping(w.a.token), 300_000_000n);
  closeTo(await dripping(w.b.token), 100_000_000n);
  assert.equal(await usdcOf(treasury), 600_000_000n);
  assert.equal(await usdcOf(feeWallet.account.address), 0n);
  assert.equal(await usdcOf(w.staking), 400_000_000n);

  await tester.increaseTime({ seconds: 3600 });
  await tester.mine({ blocks: 1 });
  await send(w.staker, w.staking, w.stakingAbi, "claim", [[w.a.token, w.b.token], w.staker.account.address]);
  const claimed = await usdcOf(w.staker.account.address);
  assert.ok(claimed <= 400_000_000n && claimed >= 400_000_000n - 4n, `${claimed}`); // rounds down, never up
});

test("chain: running again pays nothing twice", async () => {
  await stake(w.a.token);
  await trade([w.a.id], [1_000_000n]);
  const r = router();
  await collectAndScan(r);
  await r.pay();
  await collectAndScan(r);
  await r.pay();
  const fresh = router(); // and after a restart, reading from the start again
  await ledger.setCursor(startBlock);
  await collectAndScan(fresh);
  await fresh.pay();
  assert.equal(await usdcOf(treasury), 600_000n);
  assert.equal(ledger.runs.length, 1);
  assert.equal(ledger.receipts.size, 1);
});

test("chain: a token with no stakers sends everything to treasury", async () => {
  await trade([w.a.id], [1_000_000n]);
  const r = router();
  await collectAndScan(r);
  await r.pay();
  assert.equal(await usdcOf(treasury), 1_000_000n);
  assert.equal(await dripping(w.a.token), 0n);
});

test("chain: stakers leaving after the plan sends their share to treasury", async () => {
  await stake(w.a.token);
  await trade([w.a.id], [1_000_000n]);
  const r = router();
  await collectAndScan(r);
  const realCreate = ledger.createRun;
  ledger.createRun = async (...args) => {
    await send(w.staker, w.staking, w.stakingAbi, "unstake", [w.a.token, 10n ** 18n]);
    return realCreate(...args);
  };
  await r.pay();
  assert.equal(await usdcOf(treasury), 1_000_000n);
  assert.equal(await dripping(w.a.token), 0n);
  assert.equal(ledger.runs[0].status, "done");
});

test("chain: USDC sent straight to the wallet isn't a fee: it's left alone", async () => {
  await stake(w.a.token);
  await send(deployer, w.usdc, w.usdcAbi, "mint", [feeWallet.account.address, 5_000_000n]); // not from an escrow
  await trade([w.a.id], [1_000_000n]);
  const r = router();
  await collectAndScan(r);
  await r.pay();
  assert.equal(await usdcOf(feeWallet.account.address), 5_000_000n);
  assert.equal(await usdcOf(treasury), 600_000n);
  assert.equal(ledger.receipts.size, 1);
});

test("chain: a payout from an escrow that isn't one of our launches is held, never paid out", async () => {
  await trade([w.foreignPool], [1_000_000n]);
  const foreign = await pub.readContract({ address: w.fees, abi: w.feesAbi, functionName: "escrowOf", args: [w.foreignPool] });
  await send(w.trader, foreign, escrowAbi, "settle"); // the router only collects from our own escrows
  await send(w.trader, foreign, escrowAbi, "claimBuilder");
  const r = router();
  await collectAndScan(r);
  await r.pay();
  assert.equal(await usdcOf(feeWallet.account.address), 1_000_000n);
  assert.equal(ledger.runs.length, 0);
  assert.ok(logs.some((l) => l.ev === "fee_unmatched" && l.reason === "not_our_launch"));
  assert.ok(logs.some((l) => l.ev === "unmatched_held"));
});

test("attack: a fake BuilderPaid from someone's own contract records nothing, even posing as one of our pools", async () => {
  const fakeA = artifact("MockAscendFees.sol", "FakeBuilderPaid");
  const fake = await deploy(fakeA);
  await send(w.trader, fake, fakeA.abi, "fire", [feeWallet.account.address, 10n ** 30n, `0x${"cd".repeat(32)}`]);
  await send(w.trader, fake, fakeA.abi, "fire", [feeWallet.account.address, 10n ** 30n, w.a.id]); // claims our token's pool
  const r = router();
  await r.scan();
  await r.pay();
  assert.equal(ledger.receipts.size, 0, "fake payouts were recorded");
  assert.equal(ledger.runs.length, 0);
  assert.equal(logs.filter((l) => l.ev === "FAKE_BUILDER_PAID").length, 2);
});

test("chain: someone else claiming our builder fee for us (Ascend's crank) still counts", async () => {
  await stake(w.a.token);
  await trade([w.a.id], [1_000_000n]);
  await send(w.trader, w.a.escrow, escrowAbi, "settle");
  await send(w.trader, w.a.escrow, escrowAbi, "claimBuilder");
  const r = router();
  await r.scan();
  await r.pay();
  closeTo(await dripping(w.a.token), 400_000n);
  assert.equal(await usdcOf(treasury), 600_000n);
});

test("chain: collect without SEND only logs, and small amounts wait", async () => {
  await trade([w.a.id], [1_000_000n]);
  await router({ send: false }).collect();
  assert.ok(logs.some((l) => l.ev === "dry_run_settle"));
  await router({ minSettle: 2_000_000n, minClaim: 2_000_000n }).collect();
  assert.equal(await usdcOf(feeWallet.account.address), 0n);
  await router({ minClaim: 2_000_000n }).collect(); // settles, but 1 USDC owed is under the minimum claim
  assert.equal(await pub.readContract({ address: w.a.escrow, abi: escrowAbi, functionName: "builderOwed" }), 1_000_000n);
  assert.equal(await usdcOf(feeWallet.account.address), 0n);
});

test("chain: crashing before a send resends the same transaction", async () => {
  await stake(w.a.token);
  await trade([w.a.id], [1_000_000n]);
  const r = router({}, async () => {
    throw new Error("power cut");
  });
  await collectAndScan(r);
  await assert.rejects(r.pay(), /power cut/);
  const signed = ledger.runs[0].items[0].txHash;
  assert.ok(signed);

  await router().pay();
  assert.equal(ledger.runs[0].items[0].txHash, signed);
  closeTo(await dripping(w.a.token), 400_000n);
  assert.equal(await usdcOf(treasury), 600_000n);
  assert.equal(ledger.runs.length, 1);
});

test("chain: crashing after a send doesn't pay twice", async () => {
  await stake(w.a.token);
  await trade([w.a.id], [1_000_000n]);
  const real = (raw) => pub.sendRawTransaction({ serializedTransaction: raw });
  let sends = 0;
  const r = router({}, async (raw) => {
    await real(raw);
    if (++sends === 2) throw new Error("power cut right after sending");
  });
  await collectAndScan(r);
  await assert.rejects(r.pay(), /power cut/);
  await router().pay();
  closeTo(await dripping(w.a.token), 400_000n);
  assert.equal(await usdcOf(treasury), 600_000n);
  assert.equal(await usdcOf(feeWallet.account.address), 0n);
});

test("chain: a run spending more than the wallet holds doesn't start", async () => {
  await stake(w.a.token);
  await trade([w.a.id], [1_000_000n]);
  const r = router();
  await collectAndScan(r);
  await send(feeWallet, w.usdc, w.usdcAbi, "transfer", [treasury, 1n]); // someone took a little out
  await r.pay();
  assert.equal(ledger.runs.length, 0);
  assert.ok(logs.some((l) => l.ev === "WALLET_SHORT"));
});

test("chain: a reverted transaction halts everything until a person looks", async () => {
  await stake(w.a.token);
  await trade([w.a.id], [1_000_000n]);
  const code = await pub.getCode({ address: w.usdc });
  let sends = 0;
  const r = router({}, async (raw) => {
    // the last transaction, to treasury, was fine when signed but USDC now reverts everything
    if (++sends === 3) await tester.setCode({ address: w.usdc, bytecode: "0x60006000fd" });
    return pub.sendRawTransaction({ serializedTransaction: raw });
  });
  await collectAndScan(r);
  await r.pay();
  await tester.setCode({ address: w.usdc, bytecode: code });
  assert.equal(ledger.runs[0].status, "halted");
  assert.ok(logs.some((l) => l.ev === "HALTED"));

  await trade([w.a.id], [1_000_000n]);
  await collectAndScan(r);
  await r.pay();
  assert.equal(ledger.runs.length, 1);
  assert.ok(logs.some((l) => l.ev === "halted_waiting_for_a_person"));
  assert.equal(await usdcOf(feeWallet.account.address), 1_600_000n);
});

test("chain: without SEND it only logs the plan", async () => {
  await stake(w.a.token);
  await trade([w.a.id], [1_000_000n]);
  const r = router({ send: false });
  await collectAndScan(r);
  await r.pay();
  assert.equal(ledger.runs.length, 0);
  assert.equal(await usdcOf(feeWallet.account.address), 1_000_000n);
  assert.ok(logs.some((l) => l.ev === "dry_run"));
});

test("chain: below the minimum waits for more", async () => {
  await trade([w.a.id], [1_000n]);
  const r = router({ minPayout: 1_000_000n });
  await collectAndScan(r);
  await r.pay();
  assert.equal(ledger.runs.length, 0);
  assert.equal(await usdcOf(feeWallet.account.address), 1_000n);
});

test("chain: a token launched after the router started is picked up", async () => {
  const r = router();
  await collectAndScan(r);
  await trade([w.b.id], [1_000_000n]);
  await collectAndScan(r);
  assert.equal([...ledger.receipts.values()][0].token.toLowerCase(), w.b.token.toLowerCase());
});

test("chain: two tokens: each fee goes to the stakers of the token whose escrow paid it", async () => {
  await stake(w.a.token);
  await stake(w.b.token);
  await trade([w.a.id, w.b.id], [1_000_000n, 3_000_000n]);
  const r = router();
  await collectAndScan(r);
  await r.pay();
  closeTo(await dripping(w.a.token), 400_000n);
  closeTo(await dripping(w.b.token), 1_200_000n);
  assert.equal(await usdcOf(treasury), 2_400_000n);
});

// ------------------------------------------------------------------ Neuriio against the real contract

const tallyOf = (store) => makeNeuriioTally({ pub, store, cfg: { staking: w.staking, feeWallet: feeWallet.account.address, fromBlock: startBlock, confirmations: 0, maxRange: 7 } });
const later = async (seconds) => {
  await tester.increaseTime({ seconds });
  await tester.mine({ blocks: 1 });
};
const contractEarned = (who, token) => pub.readContract({ address: w.staking, abi: w.stakingAbi, functionName: "earned", args: [who, token] });
const mintedIn = (store, who, token) => store.balances.get(`${who.toLowerCase()}:${token.toLowerCase()}`) ?? 0n;

test("chain: Neuriio is exactly 100 x what the contract says each staker earned, through stakes, unstakes and claims", async () => {
  const other = await person();
  await send(deployer, w.a.token, w.usdcAbi, "mint", [other.account.address, 10n ** 24n]);
  await send(other, w.a.token, w.usdcAbi, "approve", [w.staking, 2n ** 256n - 1n]);
  const me = w.staker.account.address;
  const them = other.account.address;
  await stake(w.a.token, 3n * 10n ** 18n);
  await send(other, w.staking, w.stakingAbi, "stake", [w.a.token, 10n ** 18n]);
  const r = router();
  await trade([w.a.id], [750_000_000n]);
  await collectAndScan(r);
  await r.pay();
  await later(1000);
  await send(w.staker, w.staking, w.stakingAbi, "unstake", [w.a.token, 10n ** 18n]);
  await later(500);
  await send(w.staker, w.staking, w.stakingAbi, "claim", [[w.a.token], me]);
  await trade([w.a.id], [250_000_000n]);
  await collectAndScan(r);
  await r.pay();
  await later(1800);
  await send(other, w.staking, w.stakingAbi, "unstake", [w.a.token, 10n ** 18n]);
  await later(4000);
  const claimed = await usdcOf(me);
  const myEarned = claimed + (await contractEarned(me, w.a.token));
  const theirEarned = await contractEarned(them, w.a.token);
  const store = memoryNeuriioStore();
  await tallyOf(store).scan();
  closeTo(mintedIn(store, me, w.a.token) / 100n, myEarned);
  closeTo(mintedIn(store, them, w.a.token) / 100n, theirEarned);
  assert.ok(myEarned + theirEarned >= 399_000_000n && myEarned + theirEarned <= 400_000_000n, `${myEarned + theirEarned}`);
});

test("chain: paying rewards into your own pool and claiming them back earns no Neuriio", async () => {
  const me = w.staker.account.address;
  await stake(w.a.token);
  await send(deployer, w.usdc, w.usdcAbi, "mint", [me, 1_000_000_000n]);
  await send(w.staker, w.usdc, w.usdcAbi, "approve", [w.staking, 2n ** 256n - 1n]);
  await send(w.staker, w.staking, w.stakingAbi, "notifyReward", [w.a.token, 1_000_000_000n]);
  await later(4000);
  await send(w.staker, w.staking, w.stakingAbi, "claim", [[w.a.token], me]);
  const store = memoryNeuriioStore();
  await tallyOf(store).scan();
  assert.equal(mintedIn(store, me, w.a.token), 0n);
});

test("chain: Neuriio picks up where it left off, with the same result as one long read", async () => {
  await stake(w.a.token);
  const r = router();
  await trade([w.a.id], [100_000_000n]);
  await collectAndScan(r);
  await r.pay();
  const store = memoryNeuriioStore();
  await tallyOf(store).scan();
  await later(600);
  await send(w.staker, w.staking, w.stakingAbi, "unstake", [w.a.token, 10n ** 17n]);
  await later(4000);
  await tallyOf(store).scan();
  await tallyOf(store).scan();
  const whole = memoryNeuriioStore();
  await tallyOf(whole).scan();
  assert.equal(mintedIn(store, w.staker.account.address, w.a.token), mintedIn(whole, w.staker.account.address, w.a.token));
  closeTo(mintedIn(store, w.staker.account.address, w.a.token) / 100n, await contractEarned(w.staker.account.address, w.a.token));
});
