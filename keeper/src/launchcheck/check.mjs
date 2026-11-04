// Launch check, the chain reads (src/launchcheck/analyze.mjs does the working out). Light on the RPC by design: a few log queries a token,
// each covering all its early wallets at once, and funding is only read the first time. Later checks only refresh holdings and
// transfers between those wallets, less and less often as the token ages. Plain token and USDC events: nothing here depends on Ascend.
import { erc20Abi, parseAbi, parseAbiItem } from "viem";
import { fundingEdges, sameTxEdges, sharedFunders, summarize } from "./analyze.mjs";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const stakingAbi = parseAbi(["function stakedOf(address user, address token) view returns (uint256)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a) => a.toLowerCase();

/** A wide log query; if the RPC refuses the range or the result size, splits it and carries on. */
export async function logsAcross(pub, query, from, to) {
  try {
    return await pub.getLogs({ ...query, fromBlock: from, toBlock: to });
  } catch (e) {
    if (from >= to) throw e;
    const mid = (from + to) / 2n;
    return [...(await logsAcross(pub, query, from, mid)), ...(await logsAcross(pub, query, mid + 1n, to))];
  }
}

/** All in one call where the chain has Multicall3, otherwise one by one. */
function readAll(pub, contracts) {
  if (pub.chain?.contracts?.multicall3) return pub.multicall({ contracts, allowFailure: true });
  return Promise.all(contracts.map((c) => pub.readContract(c).then((result) => ({ status: "success", result }), () => ({ status: "failure" }))));
}

/** `cfg`: { usdc, staking?, windowSeconds, earlyBlocks, lookbackBlocks, maxWallets, hubRecipients, ignored } */
export function makeLaunchCheck({ pub, cfg }) {
  const ignored = new Set((cfg.ignored ?? []).map(lc));
  const codeCache = new Map();
  const isWallet = async (a) => {
    if (!codeCache.has(a)) {
      const code = await pub.getCode({ address: a });
      // no code, or an EIP-7702 wallet (an ordinary account with a delegate)
      codeCache.set(a, !code || code === "0x" || code.startsWith("0xef0100"));
    }
    return codeCache.get(a);
  };
  const times = new Map();
  const timeOf = async (blockNumber) => {
    if (!times.has(blockNumber)) times.set(blockNumber, (await pub.getBlock({ blockNumber })).timestamp);
    return times.get(blockNumber);
  };
  const inOrder = (logs) => [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

  /** The first time: everyone who got tokens in the window from the first buyer on, and what funded them. */
  async function first(token, launchBlock, creator, head) {
    // the window opens at the first buy, which might come long after the launch: look further each time, stopping there
    const creatorFirst = [];
    let firstOther = null;
    for (let span = BigInt(cfg.earlyBlocks), from = launchBlock; from <= head && !firstOther; from += span, span *= 4n) {
      const to = from + span - 1n < head ? from + span - 1n : head;
      for (const l of inOrder(await logsAcross(pub, { address: token, event: TRANSFER }, from, to))) {
        const r = await receiptOf(l);
        if (!r) continue;
        if (r.wallet !== creator) {
          firstOther = r;
          break;
        }
        creatorFirst.push(r);
      }
    }
    if (!firstOther && !creatorFirst.length) return null;
    const firstBuy = (firstOther ?? creatorFirst[0]).blockNumber;
    const opens = await timeOf(firstBuy);
    const closes = opens + BigInt(cfg.windowSeconds);
    const inWindow = creatorFirst.filter((r) => r.blockNumber < firstBuy);
    const last = firstBuy + BigInt(cfg.earlyBlocks) < head ? firstBuy + BigInt(cfg.earlyBlocks) : head;
    for (const l of inOrder(await logsAcross(pub, { address: token, event: TRANSFER }, firstBuy, last))) {
      if ((await timeOf(l.blockNumber)) > closes) break;
      const r = await receiptOf(l);
      if (r) inWindow.push(r);
    }
    const bought = new Map();
    for (const r of inWindow) bought.set(r.wallet, (bought.get(r.wallet) ?? 0n) + r.value);
    const wallets = [...bought.keys()].sort((a, b) => (bought.get(a) > bought.get(b) ? -1 : 1)).slice(0, cfg.maxWallets);
    const kept = new Set(wallets);

    // one query covers every wallet's funding
    const start = firstBuy > BigInt(cfg.lookbackBlocks) ? firstBuy - BigInt(cfg.lookbackBlocks) : 0n;
    const funded = (await logsAcross(pub, { address: cfg.usdc, event: TRANSFER, args: { to: wallets } }, start, firstBuy)).map((l) => ({ from: lc(l.args.from), to: lc(l.args.to) }));
    const noise = new Set(ignored);
    for (const funder of sharedFunders(funded, wallets)) {
      if (noise.has(funder)) continue;
      if (!(await isWallet(funder))) {
        noise.add(funder); // a bridge, router or exchange contract ties nobody together
        continue;
      }
      const paid = await logsAcross(pub, { address: cfg.usdc, event: TRANSFER, args: { from: funder } }, start, firstBuy);
      if (new Set(paid.map((l) => lc(l.args.to))).size > cfg.hubRecipients) noise.add(funder); // pays everyone: a faucet or an exchange wallet
    }
    const edges = [...sameTxEdges(inWindow.filter((r) => kept.has(r.wallet))), ...fundingEdges(funded, wallets, noise)];
    return { bought: [...bought].filter(([a]) => kept.has(a)).map(([a, v]) => [a, v.toString()]), edges };
  }

  /** A real wallet getting tokens from anything but another wallet, or null. A wallet-to-wallet send isn't a buy: it's a link, read separately. */
  async function receiptOf(l) {
    const [from, to] = [lc(l.args.from), lc(l.args.to)];
    if (to === ZERO || l.args.value === 0n || ignored.has(to) || !(await isWallet(to))) return null;
    if (from !== ZERO && (await isWallet(from))) return null;
    return { wallet: to, value: l.args.value, txHash: l.transactionHash, blockNumber: l.blockNumber };
  }

  /** One token. `saved`: what an earlier check kept, or null. Returns what to save and show, or null with no buyers yet. */
  async function check({ token, launchBlock, creator }, saved) {
    const address = lc(token);
    const me = creator ? lc(creator) : null;
    const head = await pub.getBlockNumber({ cacheTime: 0 });
    times.clear();
    const base = saved ?? (await first(token, BigInt(launchBlock), me, head));
    if (!base) return null;
    const bought = new Map(base.bought.map(([a, v]) => [a, BigInt(v)]));
    const wallets = [...bought.keys()];

    const moved = wallets.length > 1
      ? await logsAcross(pub, { address: token, event: TRANSFER, args: { from: wallets, to: wallets } }, BigInt(launchBlock), head)
      : [];
    const transfers = moved.map((l) => ({ a: lc(l.args.from), b: lc(l.args.to), reason: "token_transfer", via: l.transactionHash }));

    const reads = [
      { address: token, abi: erc20Abi, functionName: "totalSupply" },
      ...wallets.map((w) => ({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [w] })),
      ...(cfg.staking ? wallets.map((w) => ({ address: cfg.staking, abi: stakingAbi, functionName: "stakedOf", args: [w, token] })) : []),
    ];
    const results = await readAll(pub, reads);
    const number = (r) => (r.status === "success" ? r.result : 0n);
    const holdings = new Map(wallets.map((w, i) => [w, number(results[1 + i]) + (cfg.staking ? number(results[1 + wallets.length + i]) : 0n)]));
    const supply = number(results[0]);
    const summary = summarize({ bought, creator: me, edges: [...base.edges, ...transfers], holdings, supply, windowSeconds: cfg.windowSeconds });
    return { token: address, saved: base, summary };
  }

  return { check };
}

/** How long until a token is checked again: every 10 minutes while new, then less often with age, at least daily. */
export function nextCheckSeconds(ageSeconds) {
  return Math.min(86_400, Math.max(600, Math.floor(ageSeconds / 24)));
}

/** Goes through the launched tokens that are due. `store`: tokens() -> [{ token, launchBlock, launchedAt, creator }], rows() -> Map, save(row). */
export function makeLaunchChecker({ pub, cfg, store, log = () => {}, now = () => Date.now() }) {
  const { check } = makeLaunchCheck({ pub, cfg });
  return {
    pass: async () => {
      const [tokens, rows] = await Promise.all([store.tokens(), store.rows()]);
      const due = tokens.filter((t) => {
        const row = rows.get(lc(t.token));
        if (row) return row.nextCheck <= now();
        return Date.parse(t.launchedAt) + cfg.windowSeconds * 1000 <= now(); // not before its window could have passed
      });
      for (const t of due.slice(0, cfg.perPass ?? 50)) {
        try {
          const age = (now() - Date.parse(t.launchedAt)) / 1000;
          const result = await check(t, rows.get(lc(t.token))?.saved ?? null);
          const nextCheck = now() + nextCheckSeconds(age) * 1000;
          await store.save(result ? { ...result, nextCheck } : { token: lc(t.token), saved: null, summary: null, nextCheck: now() + 600_000 });
          log("launch_check", { token: t.token, status: result?.summary.status ?? "no_buyers" });
        } catch (e) {
          log("error", { in: "launch_check", token: t.token, error: e.shortMessage ?? e.message });
        }
      }
    },
  };
}

export function memoryLaunchStore(tokens = []) {
  const rows = new Map();
  return {
    all: rows,
    tokens: async () => tokens,
    rows: async () => rows,
    save: async (row) => void rows.set(row.token, row),
  };
}

/** Supabase, with the service key. Migration 20261102142511_launch_checks.sql. */
export function supabaseLaunchStore(url, serviceKey, registry) {
  const api = async (path, init = {}) => {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...init.headers },
    });
    if (!res.ok) throw new Error(`supabase ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  return {
    tokens: async () =>
      (await api(`tokens?registry=ilike.${registry}&launch_block=not.is.null&select=address,launch_block,launched_at,creator`)).map((t) => ({
        token: t.address,
        launchBlock: t.launch_block,
        launchedAt: t.launched_at,
        creator: t.creator,
      })),
    rows: async () =>
      new Map((await api("launch_checks?select=token,saved,next_check")).map((r) => [r.token, { saved: r.saved, nextCheck: Date.parse(r.next_check) }])),
    save: (row) =>
      api("launch_checks?on_conflict=token", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ token: row.token, saved: row.saved, summary: row.summary, next_check: new Date(row.nextCheck).toISOString(), checked_at: new Date().toISOString() }),
      }),
  };
}
