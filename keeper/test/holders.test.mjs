// Top holders scanner (src/holders/holders.mjs) on a local anvil chain: balances must equal the token's own balanceOf for every
// holder, passes read only new blocks, and a range is never counted twice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createTestClient, createWalletClient, defineChain, erc20Abi, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deltasOf, makeHolderScanner, memoryHolderStore } from "../src/holders/holders.mjs";

const PORT = 18648;
const URL_ = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [URL_] } } });
const pub = createPublicClient({ chain, transport: http(URL_), pollingInterval: 50 });
const tester = createTestClient({ chain, mode: "anvil", transport: http(URL_) }).extend(publicActions);
const deployer = createWalletClient({ chain, transport: http(URL_), account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") });
const artifact = (file, name) => {
  const a = JSON.parse(readFileSync(new URL(`../../out/${file}/${name}.json`, import.meta.url)));
  return { abi: a.abi, bytecode: a.bytecode.object };
};
let anvil, tokenA;
const E18 = 10n ** 18n;
const send = async (client, address, abi, functionName, args = []) => {
  const r = await pub.waitForTransactionReceipt({ hash: await client.writeContract({ address, abi, functionName, args }) });
  assert.equal(r.status, "success", functionName);
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
  tokenA = artifact("NeuriioLauncher.t.sol", "TestToken");
});
after(() => anvil?.kill());

test("deltasOf: mints add, transfers move, zero changes vanish, 0x0 is never a holder", () => {
  const Z = "0x0000000000000000000000000000000000000000";
  const ev = (from, to, value) => ({ args: { from, to, value } });
  const d = deltasOf([ev(Z, "0xA", 100n), ev("0xA", "0xB", 40n), ev("0xB", "0xA", 40n), ev("0xA", "0xC", 0n)]);
  assert.deepEqual([...d], [["0xa", 100n]]);
});

test("chain: balances equal balanceOf for every holder, passes are incremental, nothing counts twice", async () => {
  const token = (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: tokenA.abi, bytecode: tokenA.bytecode }) })).contractAddress;
  const launchBlock = await pub.getBlockNumber({ cacheTime: 0 });
  const [pool, a, b, c] = [await person(), await person(), await person(), await person()];
  await send(deployer, token, tokenA.abi, "mint", [pool.account.address, 1_000_000n * E18]);
  await send(pool, token, erc20Abi, "transfer", [a.account.address, 50_000n * E18]);
  await send(pool, token, erc20Abi, "transfer", [b.account.address, 20_000n * E18]);
  await send(a, token, erc20Abi, "transfer", [c.account.address, 5_000n * E18]);

  const store = memoryHolderStore([{ token, launchBlock }]);
  const reads = [];
  const real = pub.getLogs;
  pub.getLogs = (q) => (reads.push([q.fromBlock, q.toBlock]), real(q));
  const scanner = makeHolderScanner({ pub, store, cfg: { confirmations: 0 } });
  const check = async () => {
    const mine = store.balances.get(token.toLowerCase());
    for (const w of [pool, a, b, c]) {
      const onChain = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [w.account.address] });
      assert.equal(mine.get(w.account.address.toLowerCase()) ?? 0n, onChain, `balance of ${w.account.address}`);
    }
  };
  try {
    await scanner.pass();
    await check();
    assert.equal(store.balances.get(token.toLowerCase()).size, 4);

    // b sells everything back: drops out (balance 0 rows are removed); the next pass reads only the new blocks
    const scanned = store.scansMap.get(token.toLowerCase());
    await send(b, token, erc20Abi, "transfer", [pool.account.address, 20_000n * E18]);
    reads.length = 0;
    await scanner.pass();
    await check();
    assert.equal(store.balances.get(token.toLowerCase()).has(b.account.address.toLowerCase()), false);
    assert.ok(reads.length > 0 && reads.every(([from]) => from > scanned));

    // the same range again (a retry, a second service): refused, balances unchanged
    const before = new Map(store.balances.get(token.toLowerCase()));
    assert.equal(await store.apply(token.toLowerCase(), scanned + 1n, scanned + 5n, new Map([[a.account.address.toLowerCase(), 1n]])), false);
    assert.deepEqual(store.balances.get(token.toLowerCase()), before);

    // a pass with nothing new reads nothing
    reads.length = 0;
    await scanner.pass();
    assert.equal(reads.length, 0);
  } finally {
    pub.getLogs = real;
  }
});

test("chain: a long history is applied in steps and still adds up", async () => {
  const token = (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: tokenA.abi, bytecode: tokenA.bytecode }) })).contractAddress;
  const launchBlock = await pub.getBlockNumber({ cacheTime: 0 });
  const [pool, a] = [await person(), await person()];
  await send(deployer, token, tokenA.abi, "mint", [pool.account.address, 1_000n * E18]);
  for (let i = 0; i < 6; i++) {
    await tester.mine({ blocks: 3 });
    await send(pool, token, erc20Abi, "transfer", [a.account.address, E18]);
  }
  const store = memoryHolderStore([{ token, launchBlock }]);
  await makeHolderScanner({ pub, store, cfg: { confirmations: 0, applyEvery: 4 } }).pass(); // many small applies
  const m = store.balances.get(token.toLowerCase());
  assert.equal(m.get(a.account.address.toLowerCase()), 6n * E18);
  assert.equal(m.get(pool.account.address.toLowerCase()), 994n * E18);
});
