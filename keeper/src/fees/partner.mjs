// Partner fees (user, 2026-11-07): our 0.5% on trades of tokens launched ELSEWHERE, made through NeuriioSwap, paid to those
// tokens' stakers in NeuriioPartnerStaking. Same rules as the fee router (router.mjs): 40% of each token's fees to its stakers,
// never paid twice, every transaction signed and saved before it's sent, a revert halts everything until a person looks.
// The difference: the fee arrives in the pool's quote (mostly HYPE), but stakers are paid in USDC. Swapping on Elysium loses
// ~4-5% (thin HYPE/USDC pools, checked 2026-11-07), so it doesn't swap: each fee is valued at the Hyperliquid price when it's
// recorded and the 40% is paid from a USDC FLOAT the fee wallet keeps. All the HYPE stays in the wallet (the treasury's share
// plus, in effect, the HYPE it bought from the float at market). A person tops the float up.
//   scan(): reads Bought / Sold from NeuriioSwap and records the fee of each LISTED token (cfg.tokens; nothing else is
//           recorded, so a token's fees count from when it's added). A quote it can't price is held, never paid.
//   pay():  40% of each token's recorded USDC value into its pool, if its pool has stakers; the rest isn't sent anywhere (it's
//           HYPE that never left). Never spends USDC the main fee router still owes (cfg.reserve()).
// OFF until the user names the tokens (fee-router.mjs: PARTNER_TOKENS empty = this never runs).
import { encodeFunctionData, erc20Abi, formatUnits, keccak256, parseAbi, parseAbiItem } from "viem";
import { planPayout } from "./plan.mjs";

const stakingAbi = parseAbi([
  "function notifyReward(address token, uint256 amount)",
  "function totalStaked(address token) view returns (uint256)",
  "function isStakeable(address token) view returns (bool)",
]);
const swapAbi = parseAbi(["function feeWallet() view returns (address)"]);
export const swapEvents = [
  parseAbiItem("event Bought(address indexed token, address indexed buyer, address to, address quote, uint256 amountIn, uint256 fee, uint256 tokensOut)"),
  parseAbiItem("event Sold(address indexed token, address indexed seller, address to, address quote, uint256 tokensIn, uint256 amountOut, uint256 fee)"),
];
const NATIVE = "0x0000000000000000000000000000000000000000";

/** USD per whole HYPE from Hyperliquid's mid price. Throws on anything odd, so a scan stops rather than record a bad value. */
export async function hyperliquidHypeUsd(fetchFn = fetch) {
  const res = await fetchFn("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
  if (!res.ok) throw new Error(`hyperliquid allMids: ${res.status}`);
  const p = Number((await res.json()).HYPE);
  if (!(p > 0.01 && p < 100_000)) throw new Error(`hyperliquid HYPE price looks wrong: ${p}`);
  return p;
}

/** A fee in `quote` base units -> USDC base units, at `priceUsd` per whole unit. */
export function feeToUsdc(fee, decimals, priceUsd) {
  const micro = BigInt(Math.round(priceUsd * 1e6)); // USD per whole unit, in USDC base units
  return (fee * micro) / 10n ** BigInt(decimals);
}

/** `cfg`: { usdc, whype, staking (NeuriioPartnerStaking), swaps [NeuriioSwap...], tokens [listed outside tokens], fromBlock,
 *  confirmations, maxRange, minPayout, floatWarn, send, receiptTimeoutMs, hypeUsd: async () => number, reserve: async () => bigint }. */
export function makePartnerRouter({ pub, wallet, ledger, cfg, log = () => {}, broadcast }) {
  const me = wallet.account.address;
  const send = broadcast ?? ((raw) => pub.sendRawTransaction({ serializedTransaction: raw }));
  const fmt = (v) => formatUnits(v, 6);
  const lc = (a) => a.toLowerCase();
  const tokens = new Set(cfg.tokens.map(lc));
  let swaps = null; // the NeuriioSwaps whose fee wallet is ours

  /** A NeuriioSwap paying its fee anywhere else isn't paying us: its trades are none of our fees. */
  async function checkSwaps() {
    if (swaps) return swaps;
    swaps = [];
    for (const s of cfg.swaps) {
      const to = await pub.readContract({ address: s, abi: swapAbi, functionName: "feeWallet" });
      if (lc(to) === lc(me)) swaps.push(s);
      else log("SWAP_FEE_WALLET_IS_NOT_US", { swap: s, feeWallet: to });
    }
    return swaps;
  }

  /** What one fee is worth: { decimals, price } or null when we can't price its quote. */
  async function priceOf(quote, cache) {
    const q = lc(quote);
    if (!cache.has(q)) {
      if (q === NATIVE || q === lc(cfg.whype)) cache.set(q, { decimals: 18, price: await cfg.hypeUsd() });
      else if (q === lc(cfg.usdc)) cache.set(q, { decimals: 6, price: 1 });
      else cache.set(q, null);
    }
    return cache.get(q);
  }

  async function scan() {
    if (!(await checkSwaps()).length) return log("partner_no_swap_pays_us");
    const head = (await pub.getBlockNumber({ cacheTime: 0 })) - BigInt(cfg.confirmations);
    let from = (await ledger.getCursor()) ?? BigInt(cfg.fromBlock);
    while (from <= head) {
      const to = from + BigInt(cfg.maxRange) - 1n < head ? from + BigInt(cfg.maxRange) - 1n : head;
      const logs = await pub.getLogs({ address: swaps, events: swapEvents, fromBlock: from, toBlock: to });
      const prices = new Map(); // priced once per range: every fee in it uses the same price
      const rows = [];
      for (const l of logs) {
        const token = lc(l.args.token);
        if (!tokens.has(token) || l.args.fee === 0n) continue;
        const p = await priceOf(l.args.quote, prices);
        const usdc = p ? feeToUsdc(l.args.fee, p.decimals, p.price) : null;
        rows.push({
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          blockNumber: l.blockNumber,
          from: l.address,
          amount: usdc ?? 0n,
          token: usdc === null ? null : token,
          pool: null,
          reason: usdc === null ? `unpriced_quote token=${token}` : null,
          quote: l.args.quote,
          feeRaw: l.args.fee,
          priceUsd: p ? String(p.price) : null,
        });
      }
      await ledger.addReceipts(rows);
      for (const r of rows) log(r.token ? "partner_fee" : "partner_fee_held", { tx: r.txHash, token: r.token, quote: r.quote, fee: r.feeRaw.toString(), usdc: fmt(r.amount), reason: r.reason });
      await ledger.setCursor(to + 1n); // only after they're stored
      from = to + 1n;
    }
  }

  const callOf = (item) =>
    item.kind === "approve"
      ? { to: cfg.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cfg.staking, item.amount] }) }
      : { to: cfg.staking, data: encodeFunctionData({ abi: stakingAbi, functionName: "notifyReward", args: [item.token, item.amount] }) };

  /** Sends one item and waits for it. Returns false if it reverted. */
  async function runItem(item) {
    if (item.status === "sent" || item.status === "rerouted") return true;
    if (!item.txHash) {
      if (item.kind === "reward") {
        // everyone left (or the token was delisted) since the plan: keep it in the float rather than strand it
        const [staked, listed] = await Promise.all([
          pub.readContract({ address: cfg.staking, abi: stakingAbi, functionName: "totalStaked", args: [item.token] }),
          pub.readContract({ address: cfg.staking, abi: stakingAbi, functionName: "isStakeable", args: [item.token] }),
        ]);
        if (staked === 0n || !listed) {
          await ledger.setItemStatus(item, "rerouted");
          log("partner_kept", { token: item.token, usdc: fmt(item.amount), why: listed ? "no_stakers" : "delisted" });
          return true;
        }
      }
      const nonce = await pub.getTransactionCount({ address: me, blockTag: "pending" });
      const gas = ((await pub.estimateGas({ ...callOf(item), account: me })) * 3n) / 2n; // headroom: see router.mjs
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
    log("partner_sent", { kind: item.kind, token: item.token, usdc: fmt(item.amount), tx: item.txHash });
    return true;
  }

  async function finishRun(run) {
    for (const item of [...run.items].sort((a, b) => a.seq - b.seq)) {
      if (!(await runItem(item))) {
        await ledger.setRunStatus(run, "halted", `${item.kind} ${item.txHash} reverted`);
        log("PARTNER_HALTED", { run: run.id, tx: item.txHash, kind: item.kind });
        return false;
      }
    }
    await ledger.setRunStatus(run, "done");
    log("partner_run_done", { run: run.id, usdc: fmt(run.total) });
    return true;
  }

  async function pay() {
    const open = await ledger.openRun();
    if (open?.status === "halted") return log("partner_halted_waiting_for_a_person", { run: open.id });
    if (open && !(await finishRun(open))) return;
    const receipts = await ledger.unpaidMatched();
    const held = await ledger.unmatchedTotal();
    if (held > 0n) log("partner_unpriced_held");
    const staked = new Map();
    for (const token of new Set(receipts.map((r) => r.token))) {
      const [amount, listed] = await Promise.all([
        pub.readContract({ address: cfg.staking, abi: stakingAbi, functionName: "totalStaked", args: [token] }),
        pub.readContract({ address: cfg.staking, abi: stakingAbi, functionName: "isStakeable", args: [token] }),
      ]);
      staked.set(token, listed ? amount : 0n); // delisted: notifyReward would revert, so its share stays
    }
    const plan = planPayout(receipts, staked);
    if (plan.total < BigInt(cfg.minPayout)) return log("partner_below_min", { usdc: fmt(plan.total) });
    const toStakers = plan.rewards.reduce((a, r) => a + r.amount, 0n);
    const [balance, reserved] = await Promise.all([
      pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
      cfg.reserve(),
    ]);
    const free = balance > reserved ? balance - reserved : 0n;
    if (free < toStakers) return log("PARTNER_FLOAT_LOW", { need: fmt(toStakers), free: fmt(free), reservedForAscendFees: fmt(reserved) });
    if (free - toStakers < BigInt(cfg.floatWarn)) log("partner_float_running_low", { leftAfter: fmt(free - toStakers) });
    log("partner_plan", { feesUsdc: fmt(plan.total), stakers: fmt(toStakers), tokens: plan.rewards.length });
    if (!cfg.send) return log("partner_dry_run", { rewards: plan.rewards.map((r) => ({ token: r.token, usdc: fmt(r.amount) })) });
    const items = [
      ...(toStakers > 0n ? [{ kind: "approve", token: null, amount: toStakers }] : []),
      ...plan.rewards.map((r) => ({ kind: "reward", token: r.token, amount: r.amount })),
    ];
    await finishRun(await ledger.createRun(plan.total, receipts, items));
  }

  return { scan, pay };
}
