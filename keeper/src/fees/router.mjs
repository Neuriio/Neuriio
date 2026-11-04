// The fee router. Our 0.5% is Ascend's builder fee (user, 2026-11-04): it builds up in each token's own CreatorEscrow on Ascend
// and is paid to our builder address (this wallet) by `claimBuilder()`, which emits BuilderPaid. So every fee already says which
// token it came from: the escrow it was paid out of.
//   collect(): for each of our tokens, has Ascend's escrow settle what the pool collected and pay out our builder share
//              (both calls are open to anyone and only ever pay the builder; Ascend's own crank may make them too).
//   scan():    reads every BuilderPaid to this wallet and records it as a fee of the escrow's token. A payout from a real Ascend
//              escrow that isn't one of our launches (anyone can name an approved builder) is recorded unmatched and held.
//              Anyone can also emit a BuilderPaid from a contract of their own, with no money behind it: those are dropped
//              unless Ascend's factory confirms the emitter is that pool's escrow (attack found 2026-11-04: fake payouts
//              inflated the public Platform fees total).
//   pay():     a run: 40% to each token's stakers, the rest to treasury (src/fees/plan.mjs).
// It can't pay twice or overpay: a run only ever spends fees recorded as unpaid, never more than the wallet holds, and each
// transaction is signed and saved BEFORE it's sent, so after a crash the same one (same nonce) is resent, never a new one. A
// transaction that reverts halts the router until a person looks at it. Unmatched fees stay in the wallet.
import { encodeFunctionData, erc20Abi, formatUnits, keccak256, parseAbi, parseAbiItem } from "viem";
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
// Ascend V5 (keeper/abis/ascend-v5-99901-422319.json)
const factoryAbi = parseAbi(["function escrowOf(bytes32 poolId) view returns (address)"]);
const launchpadAbi = parseAbi(["function accruedFees(bytes32 poolId) view returns (uint256)"]);
const escrowAbi = parseAbi([
  "function poolId() view returns (bytes32)",
  "function builder() view returns (address)",
  "function builderOwed() view returns (uint256)",
  "function settle()",
  "function claimBuilder() returns (uint256 amount)",
]);
const builderPaid = parseAbiItem("event BuilderPaid(address indexed builder, uint256 amount)");

/** `cfg`: { usdc, staking, launcher, escrowFactory, launchpad, treasury, fromBlock, confirmations, maxRange, minPayout, minSettle,
 *  minClaim, send, receiptTimeoutMs }. `wallet` holds the builder address's key. `broadcast` is only replaced in tests. */
export function makeFeeRouter({ pub, wallet, ledger, cfg, log = () => {}, broadcast }) {
  const me = wallet.account.address;
  const send = broadcast ?? ((raw) => pub.sendRawTransaction({ serializedTransaction: raw }));
  const fmt = (v) => formatUnits(v, 6);
  const escrows = new Map(); // escrow (lower case) -> { token, pool, escrow }
  const genuine = new Map(); // any other emitter (lower case) -> whether Ascend's factory says it's a real escrow
  let known = 0n;

  /** A BuilderPaid from a contract that isn't one of our escrows: real only if the factory names it as its pool's escrow. */
  async function isRealEscrow(address) {
    const key = address.toLowerCase();
    if (!genuine.has(key)) {
      let real = false;
      try {
        const pool = await pub.readContract({ address, abi: escrowAbi, functionName: "poolId" });
        const escrow = await pub.readContract({ address: cfg.escrowFactory, abi: factoryAbi, functionName: "escrowOf", args: [pool] });
        real = escrow.toLowerCase() === key;
      } catch {
        real = false; // no poolId(): not an escrow
      }
      genuine.set(key, real);
    }
    return genuine.get(key);
  }

  /** Our tokens' escrows: reads only tokens launched since the last look. */
  async function refreshEscrows() {
    const n = await pub.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "allTokensLength" });
    for (; known < n; known++) {
      const token = await pub.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "allTokens", args: [known] });
      const { pool } = await pub.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "launchOf", args: [token] });
      const escrow = await pub.readContract({ address: cfg.escrowFactory, abi: factoryAbi, functionName: "escrowOf", args: [pool] });
      const builder = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "builder" });
      if (builder.toLowerCase() !== me.toLowerCase()) log("ESCROW_BUILDER_IS_NOT_US", { token, escrow, builder });
      escrows.set(escrow.toLowerCase(), { token, pool, escrow });
    }
  }

  /** One collection call (settle / claimBuilder): harmless to repeat, so it isn't tracked like a payout. */
  async function call(escrow, functionName) {
    const data = encodeFunctionData({ abi: escrowAbi, functionName });
    const gas = ((await pub.estimateGas({ to: escrow, data, account: me })) * 3n) / 2n;
    const nonce = await pub.getTransactionCount({ address: me, blockTag: "pending" });
    const request = await wallet.prepareTransactionRequest({ to: escrow, data, account: wallet.account, chain: wallet.chain, nonce, gas });
    const raw = await wallet.account.signTransaction(request);
    const hash = await send(raw);
    const receipt = await pub.waitForTransactionReceipt({ hash: hash ?? keccak256(raw), timeout: cfg.receiptTimeoutMs });
    return receipt.status === "success";
  }

  async function collect() {
    await refreshEscrows();
    for (const { token, pool, escrow } of escrows.values()) {
      try {
        const accrued = await pub.readContract({ address: cfg.launchpad, abi: launchpadAbi, functionName: "accruedFees", args: [pool] });
        if (accrued >= BigInt(cfg.minSettle)) {
          if (!cfg.send) log("dry_run_settle", { token, usdc: fmt(accrued) });
          else if (!(await call(escrow, "settle"))) log("settle_reverted", { token, escrow });
        }
        const owed = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "builderOwed" });
        if (owed < BigInt(cfg.minClaim)) continue;
        if (!cfg.send) log("dry_run_claim", { token, usdc: fmt(owed) });
        else if (!(await call(escrow, "claimBuilder"))) log("claim_reverted", { token, escrow });
      } catch (e) {
        log("collect_failed", { token, escrow, error: e.shortMessage ?? e.message });
      }
    }
  }

  async function scan() {
    const head = (await pub.getBlockNumber({ cacheTime: 0 })) - BigInt(cfg.confirmations);
    let from = (await ledger.getCursor()) ?? BigInt(cfg.fromBlock);
    while (from <= head) {
      const to = from + BigInt(cfg.maxRange) - 1n < head ? from + BigInt(cfg.maxRange) - 1n : head;
      // every escrow's payout to us, wherever it came from; matched to a token by which escrow paid it
      const logs = await pub.getLogs({ event: builderPaid, args: { builder: me }, fromBlock: from, toBlock: to });
      if (logs.length) await refreshEscrows();
      const real = [];
      for (const l of logs) {
        if (escrows.has(l.address.toLowerCase()) || (await isRealEscrow(l.address))) real.push(l);
        else log("FAKE_BUILDER_PAID", { tx: l.transactionHash, from: l.address, amount: l.args.amount.toString() });
      }
      const rows = real.map((l) => {
        const ours = escrows.get(l.address.toLowerCase());
        return {
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          blockNumber: l.blockNumber,
          from: l.address,
          amount: l.args.amount,
          token: ours?.token ?? null,
          pool: ours?.pool ?? null,
          reason: ours ? null : "not_our_launch",
        };
      });
      await ledger.addReceipts(rows);
      for (const r of rows) log(r.token ? "fee" : "fee_unmatched", { tx: r.txHash, token: r.token, usdc: fmt(r.amount), reason: r.reason });
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
      // headroom over the estimate: an exact estimate can run out at the very end (the staking contract's re-entrancy guard
      // needs gas left over; the 2026-11-04 deploy rehearsal on a testnet fork hit ReentrancySentryOOG without it)
      const gas = ((await pub.estimateGas({ ...callOf(item), account: me })) * 3n) / 2n;
      const request = await wallet.prepareTransactionRequest({ ...callOf(item), account: wallet.account, chain: wallet.chain, nonce, gas });
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

  return { collect, scan, pay };
}
