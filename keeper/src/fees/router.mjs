// The fee router: Ascend sends plain USDC to one wallet, and this works out which token paid what and passes it on.
//   scan(): watches only USDC transfers into the wallet (one narrow filter), reads each such transaction once, and records
//           each fee with its token (src/fees/match.mjs).
//   pay():  a run: 40% to each token's stakers, the rest to treasury (src/fees/plan.mjs).
// It can't pay twice or overpay: a run only ever spends fees recorded as unpaid, never more than the wallet holds, and each
// transaction is signed and saved BEFORE it's sent, so after a crash the same one (same nonce) is resent, never a new one. A
// transaction that reverts halts the router until a person looks at it. Unmatched fees stay in the wallet.
import { encodeFunctionData, erc20Abi, formatUnits, keccak256, parseAbi, parseAbiItem } from "viem";
import { swapsInLogs } from "./ascend.mjs";
import { matchFees } from "./match.mjs";
import { planPayout } from "./plan.mjs";

const stakingAbi = parseAbi([
  "function notifyReward(address token, uint256 amount)",
  "function totalStaked(address token) view returns (uint256)",
]);
const launcherAbi = parseAbi([
  "struct Launch { address creator; uint64 xUserId; uint8 category; bytes32 profileHash; bytes32 pool; string handle; }",
  "function allTokensLength() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function launchOf(address token) view returns (Launch)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** `cfg`: { usdc, staking, launcher, poolManager, treasury, feeSource?, fromBlock, confirmations, maxRange, minPayout, send,
 *  receiptTimeoutMs }. `wallet` holds the fee wallet's key. `broadcast` is only replaced in tests. */
export function makeFeeRouter({ pub, wallet, ledger, cfg, log = () => {}, broadcast }) {
  const me = wallet.account.address;
  const send = broadcast ?? ((raw) => pub.sendRawTransaction({ serializedTransaction: raw }));
  const fmt = (v) => formatUnits(v, 6);
  const poolToToken = new Map();
  let known = 0n;

  /** Our pools: reads only tokens launched since the last look. */
  async function refreshPools() {
    const n = await pub.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "allTokensLength" });
    for (; known < n; known++) {
      const token = await pub.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "allTokens", args: [known] });
      const { pool } = await pub.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "launchOf", args: [token] });
      poolToToken.set(pool.toLowerCase(), token);
    }
  }

  async function scan() {
    const head = (await pub.getBlockNumber({ cacheTime: 0 })) - BigInt(cfg.confirmations);
    let from = (await ledger.getCursor()) ?? BigInt(cfg.fromBlock);
    while (from <= head) {
      const to = from + BigInt(cfg.maxRange) - 1n < head ? from + BigInt(cfg.maxRange) - 1n : head;
      const logs = await pub.getLogs({ address: cfg.usdc, event: transferEvent, args: { to: me }, fromBlock: from, toBlock: to });
      if (logs.length) await refreshPools();
      const byTx = new Map();
      for (const l of logs) byTx.set(l.transactionHash, [...(byTx.get(l.transactionHash) ?? []), l]);
      for (const [hash, transfers] of byTx) {
        const receipt = await pub.getTransactionReceipt({ hash });
        const fees = transfers.map((l) => ({ txHash: hash, logIndex: l.logIndex, blockNumber: l.blockNumber, from: l.args.from, amount: l.args.value }));
        const rows = matchFees(fees, swapsInLogs(receipt.logs, cfg.poolManager), poolToToken, cfg.feeSource);
        await ledger.addReceipts(rows);
        for (const r of rows) log(r.token ? "fee" : "fee_unmatched", { tx: hash, token: r.token, usdc: fmt(r.amount), reason: r.reason });
      }
      await ledger.setCursor(to + 1n); // only after they're stored
      from = to + 1n;
    }
  }

  const callOf = (item) => {
    if (item.kind === "approve") return { to: cfg.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cfg.staking, item.amount] }) };
    if (item.kind === "reward") return { to: cfg.staking, data: encodeFunctionData({ abi: stakingAbi, functionName: "notifyReward", args: [item.token, item.amount] }) };
    return { to: cfg.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [cfg.treasury, item.amount] }) };
  };

  /** Sends one item and waits for it. Returns false if it reverted. */
  async function runItem(item, treasuryItem) {
    if (item.status === "sent" || item.status === "rerouted") return true;
    if (!item.txHash) {
      // everyone left since the plan: the contract would hold it for the first staker
      if (item.kind === "reward") {
        const staked = await pub.readContract({ address: cfg.staking, abi: stakingAbi, functionName: "totalStaked", args: [item.token] });
        if (staked === 0n) {
          await ledger.setItemStatus(item, "rerouted"); // first: a crash here leaves money in the wallet, never spends it twice
          await ledger.addToItem(treasuryItem, item.amount);
          log("rerouted", { token: item.token, usdc: fmt(item.amount) });
          return true;
        }
      }
      const nonce = await pub.getTransactionCount({ address: me, blockTag: "pending" });
      const request = await wallet.prepareTransactionRequest({ ...callOf(item), account: wallet.account, chain: wallet.chain, nonce });
      const raw = await wallet.account.signTransaction(request);
      await ledger.saveSigned(item, keccak256(raw), raw);
    }
    const mined = await pub.getTransactionReceipt({ hash: item.txHash }).catch(() => null);
    if (!mined) {
      await send(item.rawTx).catch((e) => {
        if (!/already known|nonce too low|already imported/i.test(e.message)) throw e;
      });
    }
    const receipt = mined ?? (await pub.waitForTransactionReceipt({ hash: item.txHash, timeout: cfg.receiptTimeoutMs }));
    if (receipt.status !== "success") {
      await ledger.setItemStatus(item, "failed");
      return false;
    }
    await ledger.setItemStatus(item, "sent");
    log("sent", { kind: item.kind, token: item.token, usdc: fmt(item.amount), tx: item.txHash });
    return true;
  }

  async function finishRun(run) {
    const treasuryItem = run.items.find((i) => i.kind === "treasury");
    for (const item of [...run.items].sort((a, b) => a.seq - b.seq)) {
      if (!(await runItem(item, treasuryItem))) {
        await ledger.setRunStatus(run, "halted", `${item.kind} ${item.txHash} reverted`);
        log("HALTED", { run: run.id, tx: item.txHash, kind: item.kind });
        return false;
      }
    }
    await ledger.setRunStatus(run, "done");
    log("run_done", { run: run.id, usdc: fmt(run.total) });
    return true;
  }

  async function pay() {
    const open = await ledger.openRun();
    if (open?.status === "halted") return log("halted_waiting_for_a_person", { run: open.id });
    if (open && !(await finishRun(open))) return;
    const receipts = await ledger.unpaidMatched();
    const [held, balance] = await Promise.all([
      ledger.unmatchedTotal(),
      pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
    ]);
    if (held > 0n) log("unmatched_held", { usdc: fmt(held) });
    const staked = new Map();
    for (const token of new Set(receipts.map((r) => r.token))) {
      staked.set(token, await pub.readContract({ address: cfg.staking, abi: stakingAbi, functionName: "totalStaked", args: [token] }));
    }
    const plan = planPayout(receipts, staked);
    if (plan.total < BigInt(cfg.minPayout)) return log("below_min", { usdc: fmt(plan.total) });
    if (balance < plan.total) return log("WALLET_SHORT", { recorded: fmt(plan.total), balance: fmt(balance) });
    const toStakers = plan.rewards.reduce((a, r) => a + r.amount, 0n);
    log("plan", { usdc: fmt(plan.total), stakers: fmt(toStakers), treasury: fmt(plan.treasury), tokens: plan.rewards.length });
    if (!cfg.send) return log("dry_run", { rewards: plan.rewards.map((r) => ({ token: r.token, usdc: fmt(r.amount) })) });
    const items = [
      ...(toStakers > 0n ? [{ kind: "approve", token: null, amount: toStakers }] : []),
      ...plan.rewards.map((r) => ({ kind: "reward", token: r.token, amount: r.amount })),
      { kind: "treasury", token: null, amount: plan.treasury },
    ];
    await finishRun(await ledger.createRun(plan.total, receipts, items));
  }

  return { scan, pay };
}
