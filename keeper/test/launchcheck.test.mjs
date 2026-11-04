// The launch check. The first tests are pure; the rest stage launches on a local chain (anvil). Needs `forge build` first.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fundingEdges, groupsOf, sameTxEdges, sharedFunders, summarize } from "../src/launchcheck/analyze.mjs";
import { makeLaunchCheck, makeLaunchChecker, memoryLaunchStore, nextCheckSeconds } from "../src/launchcheck/check.mjs";

const SUPPLY = 1000n;
const summaryOf = (bought, edges = [], creator = null, holdings = new Map()) =>
  summarize({ bought: new Map(bought), edges, creator, holdings: new Map(holdings), supply: SUPPLY, windowSeconds: 60 });

test("groups: joined by any chain of edges, and loners aren't a group", () => {
  const g = groupsOf(["a", "b", "c", "d", "e"], [{ a: "a", b: "b" }, { a: "b", b: "c" }, { a: "d", b: "z" }]);
  assert.equal(g.get("a"), g.get("c"));
  assert.ok(g.get("a"));
  assert.equal(g.has("d"), false);
  assert.equal(g.has("e"), false);
});

test("same transaction links its wallets, separate ones don't", () => {
  const edges = sameTxEdges([{ txHash: "1", wallet: "a" }, { txHash: "1", wallet: "b" }, { txHash: "2", wallet: "c" }, { txHash: "1", wallet: "a" }]);
  assert.deepEqual(edges.map((e) => [e.a, e.b, e.reason]), [["a", "b", "same_tx"]]);
});

test("funding: a shared funder or a direct payment links, a hub or a lone funder doesn't", () => {
  const wallets = ["a", "b", "c"];
  assert.deepEqual(fundingEdges([{ from: "f", to: "a" }, { from: "f", to: "b" }], wallets).map((e) => [e.a, e.b, e.reason, e.via]), [["a", "b", "same_funder", "f"]]);
  assert.deepEqual(fundingEdges([{ from: "a", to: "b" }], wallets).map((e) => [e.a, e.b, e.reason]), [["a", "b", "funded_directly"]]);
  assert.deepEqual(fundingEdges([{ from: "f", to: "a" }, { from: "f", to: "b" }], wallets, new Set(["f"])), []);
  assert.deepEqual(fundingEdges([{ from: "f", to: "a" }, { from: "f", to: "a" }, { from: "g", to: "b" }], wallets), []);
  assert.deepEqual(fundingEdges([{ from: "a", to: "a" }, { from: "f", to: "x" }, { from: "f", to: "y" }], wallets), []);
  assert.deepEqual(sharedFunders([{ from: "f", to: "a" }, { from: "f", to: "b" }, { from: "g", to: "a" }, { from: "a", to: "b" }], wallets), ["f"]);
});

test("summary: nobody early", () => {
  const s = summaryOf([]);
  assert.deepEqual([s.status, s.early_wallets, s.early_pct, s.linked_wallets], ["none", 0, 0, 0]);
});

test("summary: timing alone is only fast buyers, never linked", () => {
  const s = summaryOf([["a", 100n], ["b", 50n], ["c", 50n]], [], null, [["a", 100n], ["b", 0n]]);
  assert.deepEqual([s.status, s.early_wallets, s.early_pct, s.linked_wallets, s.linked_pct, s.held_pct], ["fast", 3, 20, 0, 0, 10]);
  assert.deepEqual(s.wallets.map((w) => w.address), ["a", "b", "c"]);
  assert.ok(s.wallets.every((w) => w.group === null && w.reasons.length === 0));
});

test("summary: linked wallets, with why, and what they still hold", () => {
  const edges = [{ a: "a", b: "b", reason: "same_funder", via: "f" }, { a: "b", b: "z", reason: "same_tx" }];
  const s = summaryOf([["a", 100n], ["b", 100n], ["c", 10n]], edges, null, [["a", 50n], ["b", 0n], ["c", 10n]]);
  assert.deepEqual([s.status, s.early_wallets, s.early_pct, s.linked_wallets, s.linked_pct, s.held_pct], ["linked", 3, 21, 2, 20, 5]);
  assert.deepEqual(s.wallets.find((w) => w.address === "a").reasons, ["same_funder"]);
  assert.equal(s.wallets.find((w) => w.address === "c").group, null);
});

test("summary: the creator's first buy is apart, unless it's linked to the others", () => {
  const alone = summaryOf([["me", 20n], ["a", 100n]], [], "me");
  assert.deepEqual([alone.status, alone.early_wallets, alone.early_pct, alone.creator_pct], ["fast", 1, 10, 2]);
  const onlyMe = summaryOf([["me", 20n]], [], "me");
  assert.deepEqual([onlyMe.status, onlyMe.early_wallets, onlyMe.creator_pct], ["none", 0, 2]);
  const tied = summaryOf([["me", 20n], ["a", 100n]], [{ a: "me", b: "a", reason: "funded_directly" }], "me");
  assert.deepEqual([tied.status, tied.early_wallets, tied.early_pct, tied.linked_wallets, tied.creator_pct], ["linked", 2, 12, 2, 0]);
});

test("rechecks slow down with age: 10 minutes when new, at most a day", () => {
  assert.equal(nextCheckSeconds(0), 600);
  assert.equal(nextCheckSeconds(86_400), 3600);
  assert.equal(nextCheckSeconds(10 ** 9), 86_400);
});

// ------------------------------------------------------------------ on a local chain

const artifact = (file, name) => {
  const a = JSON.parse(readFileSync(new URL(`../../out/${file}/${name}.json`, import.meta.url)));
  return { abi: a.abi, bytecode: a.bytecode.object };
};
const PORT = 18646;
const URL_ = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [URL_] } } });
const pub = createPublicClient({ chain, transport: http(URL_), pollingInterval: 50 });
const tester = createTestClient({ chain, mode: "anvil", transport: http(URL_) }).extend(publicActions);
const deployer = createWalletClient({ chain, transport: http(URL_), account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") });

let anvil, tokenA, bundlerA, usdc, snapshot;
const send = async (client, address, abi, functionName, args = []) => {
  const r = await pub.waitForTransactionReceipt({ hash: await client.writeContract({ address, abi, functionName, args }) });
  assert.equal(r.status, "success", functionName);
  return r;
};
const deploy = async (a, args = []) => (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode, args }) })).contractAddress;
const person = async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  await tester.setBalance({ address: account.address, value: 10n ** 20n });
  return createWalletClient({ chain, transport: http(URL_), account });
};
const later = async (seconds) => {
  await tester.increaseTime({ seconds });
  await tester.mine({ blocks: 1 });
};

const E18 = 10n ** 18n;
/** A launch: a token whose whole supply sits in a pool contract. */
async function launch() {
  const token = await deploy(tokenA);
  const pool = await deploy(bundlerA);
  const launchBlock = await pub.getBlockNumber({ cacheTime: 0 });
  await send(deployer, token, tokenA.abi, "mint", [pool, 1_000_000n * E18]);
  return { token, pool, launchBlock };
}
const buy = (l, wallets, amount = 10_000n * E18) => send(deployer, l.pool, bundlerA.abi, "payOut", [l.token, wallets.map((w) => w.account.address), amount]);
const fund = (from, to, amount = 1_000_000n) => send(from, usdc, tokenA.abi, "transfer", [to.account.address, amount]);
const funder = async () => {
  const f = await person();
  await send(deployer, usdc, tokenA.abi, "mint", [f.account.address, 10n ** 12n]);
  return f;
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
  tokenA = artifact("NeuriioLauncher.t.sol", "TestToken");
  bundlerA = artifact("MockBundler.sol", "MockBundler");
  usdc = await deploy(tokenA);
  snapshot = await tester.snapshot();
});
after(() => anvil?.kill());
beforeEach(async () => {
  await tester.revert({ id: snapshot });
  snapshot = await tester.snapshot();
});

const cfg = { usdc: null, windowSeconds: 60, earlyBlocks: 50, lookbackBlocks: 100_000, maxWallets: 50, hubRecipients: 3 };
const run = (l, creator = null, over = {}, saved = null) =>
  makeLaunchCheck({ pub, cfg: { ...cfg, usdc, ...over } }).check({ token: l.token, launchBlock: l.launchBlock, creator }, saved);
const at = (w) => w.account.address.toLowerCase();

test("chain: unrelated early buyers are only fast buyers", async () => {
  const l = await launch();
  const [a, b, c] = [await person(), await person(), await person()];
  await buy(l, [a]);
  await buy(l, [b]);
  await buy(l, [c]);
  const { summary: s } = await run(l);
  assert.deepEqual([s.status, s.early_wallets, s.linked_wallets], ["fast", 3, 0]);
  assert.equal(s.early_pct, 3);
  assert.equal(s.held_pct, 3);
});

test("chain: one transaction paying several wallets is linked", async () => {
  const l = await launch();
  const [a, b, c] = [await person(), await person(), await person()];
  await buy(l, [a, b]);
  await buy(l, [c]);
  const { summary: s } = await run(l);
  assert.deepEqual([s.status, s.early_wallets, s.linked_wallets], ["linked", 3, 2]);
  assert.deepEqual(s.wallets.find((w) => w.address === at(a)).reasons, ["same_tx"]);
  assert.equal(s.wallets.find((w) => w.address === at(c)).group, null);
});

test("chain: wallets funded by one wallet before buying are linked; bought before funding isn't", async () => {
  const l = await launch();
  const f = await funder();
  const [a, b, c] = [await person(), await person(), await person()];
  await fund(f, a);
  await fund(f, b);
  await buy(l, [a]);
  await buy(l, [b]);
  await buy(l, [c]);
  await fund(f, c); // after its buy: says nothing about the launch
  const { summary: s } = await run(l);
  assert.equal(s.linked_wallets, 2);
  assert.deepEqual(s.wallets.find((w) => w.address === at(a)).reasons, ["same_funder"]);
  assert.equal(s.wallets.find((w) => w.address === at(c)).group, null);
});

test("chain: one early buyer funding another is linked", async () => {
  const l = await launch();
  const a = await funder();
  const b = await person();
  await fund(a, b);
  await buy(l, [a]);
  await buy(l, [b]);
  const { summary: s } = await run(l);
  assert.equal(s.linked_wallets, 2);
  assert.deepEqual(s.wallets[0].reasons, ["funded_directly"]);
});

test("chain: a hub paying everyone, or a contract, ties nobody together", async () => {
  const l = await launch();
  const hub = await funder();
  const [a, b] = [await person(), await person()];
  for (const w of [a, b, await person(), await person()]) await fund(hub, w);
  await buy(l, [a]);
  await buy(l, [b]);
  assert.equal((await run(l)).summary.status, "fast");

  const l2 = await launch();
  const bridge = await deploy(bundlerA);
  await send(deployer, usdc, tokenA.abi, "mint", [bridge, 10n ** 12n]);
  const [c, d] = [await person(), await person()];
  await send(deployer, bridge, bundlerA.abi, "payOut", [usdc, [c.account.address, d.account.address], 1_000_000n]);
  await buy(l2, [c]);
  await buy(l2, [d]);
  assert.equal((await run(l2)).summary.status, "fast");

  const l3 = await launch();
  const f = await funder();
  const [e, g] = [await person(), await person()];
  await fund(f, e);
  await fund(f, g);
  await buy(l3, [e]);
  await buy(l3, [g]);
  assert.equal((await run(l3)).summary.status, "linked");
  assert.equal((await run(l3, null, { ignored: [f.account.address] })).summary.status, "fast", "listed as an exchange");
});

test("chain: passing tokens between wallets links them, and a send isn't counted as a buy", async () => {
  const l = await launch();
  const [a, b] = [await person(), await person()];
  await buy(l, [a]);
  await buy(l, [b]);
  await send(a, l.token, tokenA.abi, "transfer", [b.account.address, 5_000n * E18]);
  const { summary: s } = await run(l);
  assert.equal(s.linked_wallets, 2);
  assert.deepEqual(s.wallets.map((w) => w.pct), [1, 1]);
  assert.deepEqual(s.wallets.find((w) => w.address === at(a)).reasons, ["token_transfer"]);
  assert.equal(s.held_pct, 2);
});

test("chain: the window opens at the first buy, and later buyers aren't early", async () => {
  const l = await launch();
  await later(3600); // nobody bought for an hour
  const [a, b] = [await person(), await person()];
  await buy(l, [a]);
  await later(30);
  await buy(l, [b]);
  await later(61);
  await buy(l, [await person()]);
  const { summary: s } = await run(l);
  assert.equal(s.early_wallets, 2);
});

test("chain: finds a first buy long after the launch, however many blocks later", async () => {
  const l = await launch();
  await tester.mine({ blocks: 500 });
  await buy(l, [await person()]);
  assert.equal((await run(l)).summary.early_wallets, 1);
});

test("chain: a buy right at the end of a scan range keeps the wallets just after it, and the creator's buy before it", async () => {
  const l = await launch();
  const me = await person();
  await buy(l, [me]);
  await tester.mine({ blocks: cfg.earlyBlocks - 4 }); // the first buy lands on the range's last blocks
  const [a, b] = [await person(), await person()];
  await buy(l, [a]);
  await tester.mine({ blocks: 3 });
  await buy(l, [b]);
  const { summary: s } = await run(l, me.account.address);
  assert.equal(s.early_wallets, 2);
  assert.equal(s.creator_pct, 1);
});

test("chain: the creator's first buy stays apart and can come before the window", async () => {
  const l = await launch();
  const me = await person();
  await buy(l, [me]);
  await later(600);
  await buy(l, [await person()]);
  const { summary: s } = await run(l, me.account.address);
  assert.deepEqual([s.status, s.early_wallets, s.creator_pct], ["fast", 1, 1]);
  assert.equal(s.wallets.find((w) => w.creator).address, at(me));
});

test("chain: selling shows up, and a recheck reuses the first look without reading funding again", async () => {
  const l = await launch();
  const f = await funder();
  const [a, b] = [await person(), await person()];
  await fund(f, a);
  await fund(f, b);
  await buy(l, [a]);
  await buy(l, [b]);
  const one = await run(l);
  assert.equal(one.summary.held_pct, 2);
  await send(a, l.token, tokenA.abi, "transfer", [l.pool, 10_000n * E18]); // sold
  const real = pub.getLogs;
  const reads = [];
  pub.getLogs = (q) => (reads.push(q.address.toLowerCase()), real(q));
  try {
    const two = await run(l, null, {}, JSON.parse(JSON.stringify(one.saved)));
    assert.equal(two.summary.held_pct, 1);
    assert.equal(two.summary.linked_wallets, 2);
    assert.deepEqual(reads, [l.token.toLowerCase()]);
  } finally {
    pub.getLogs = real;
  }
});

test("chain: no buyers yet is nothing to show, not an error", async () => {
  assert.equal(await run(await launch()), null);
});

test("chain: if the RPC refuses a wide range, it splits it and gets the same answer", async () => {
  const l = await launch();
  const f = await funder();
  const [a, b] = [await person(), await person()];
  await fund(f, a);
  await fund(f, b);
  await buy(l, [a]);
  await buy(l, [b]);
  const real = pub.getLogs;
  pub.getLogs = (q) => (q.toBlock - q.fromBlock > 4n ? Promise.reject(new Error("range too large")) : real(q));
  try {
    assert.equal((await run(l)).summary.linked_wallets, 2);
  } finally {
    pub.getLogs = real;
  }
});

test("chain: the service checks what's due, skips what isn't, and one bad token doesn't stop the rest", async () => {
  const l = await launch();
  const a = await person();
  await buy(l, [a]);
  const now = Date.now();
  const iso = (ago) => new Date(now - ago * 1000).toISOString();
  const store = memoryLaunchStore([
    { token: l.token, launchBlock: l.launchBlock, launchedAt: iso(3600), creator: null },
    { token: l.token.replace(/.$/, "0"), launchBlock: l.launchBlock, launchedAt: iso(5), creator: null }, // too new
    { token: "0xnot-an-address", launchBlock: l.launchBlock, launchedAt: iso(3600), creator: null },
  ]);
  const logs = [];
  const checker = makeLaunchChecker({ pub, store, cfg: { ...cfg, usdc }, log: (ev, o) => logs.push({ ev, ...o }), now: () => now });
  await checker.pass();
  assert.deepEqual([...store.all.keys()], [l.token.toLowerCase()]);
  const row = store.all.get(l.token.toLowerCase());
  assert.equal(row.summary.early_wallets, 1);
  assert.equal(row.nextCheck, now + 600_000);
  assert.ok(logs.some((x) => x.ev === "error"));
  const before = logs.length;
  await checker.pass(); // not due again yet
  assert.equal(logs.filter((x, i) => i >= before && x.ev === "launch_check").length, 0);
});
