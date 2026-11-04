// Neuriio: stakers are the only ones who get it, 100 for every $1 of fees they earn (user, 2026-11-01). A tally until the token
// launches: nothing here is on-chain.
//
// This replays the staking contract's own events with its own math, rather than reading its earned(), because notifyReward is open to
// anyone: someone could stake their own token, pay USDC into its pool, claim it straight back and repeat, for free Neuriio. So only
// rewards sent by the fee wallet count. If the fee wallet is the only payer, a staker's Neuriio is exactly 100 x what they earned.
import { parseAbiItem } from "viem";

export const NEURIIO_PER_USDC = 100n;
const USDC = 1_000_000n; // base units
/** 1B Neuriio at 100 per $1: fee rewards stop counting once this many have been paid to stakers. */
export const MAX_REWARDS = (1_000_000_000n / NEURIIO_PER_USDC) * USDC;
const DRIP = 3600n; // NeuriioTokenStaking.DRIP
const RATE = 10n ** 18n; // ...RATE
const ACC = 10n ** 36n; // ...ACC
const EVENTS = [
  parseAbiItem("event Staked(address indexed user, address indexed token, uint256 amount)"),
  parseAbiItem("event Unstaked(address indexed user, address indexed token, uint256 amount)"),
  parseAbiItem("event RewardAdded(address indexed token, uint256 amount, uint256 dripEnd)"),
];

export const emptyTally = () => ({ pools: {}, positions: {}, rewards: 0n });

const poolOf = (s, token) => (s.pools[token] ??= { total: 0n, rate: 0n, acc: 0n, last: 0n, end: 0n });
const positionOf = (s, user, token) => (s.positions[`${user}:${token}`] ??= { amount: 0n, accPaid: 0n, owed: 0n });

function accNow(p, now) {
  const end = now < p.end ? now : p.end;
  if (end <= p.last || p.total === 0n) return p.acc;
  return p.acc + ((end - p.last) * p.rate * (ACC / RATE)) / p.total;
}

function update(p, now) {
  if (now === p.last) return;
  if (p.end > p.last) {
    if (p.total === 0n) p.end = now + p.end - p.last; // nobody staked: the drip waits for the next staker
    else p.acc = accNow(p, now);
  }
  p.last = now;
}

function settle(p, pos) {
  if (pos.amount > 0n) pos.owed += (pos.amount * (p.acc - pos.accPaid)) / ACC;
  pos.accPaid = p.acc;
}

/** Applies one event, oldest first: { kind, user, token, amount, time, fromFeeWallet }. Lower-case addresses. */
export function applyEvent(s, e) {
  const p = poolOf(s, e.token);
  update(p, e.time);
  if (e.kind === "RewardAdded") {
    if (!e.fromFeeWallet) return;
    const room = MAX_REWARDS - s.rewards;
    const amount = e.amount < room ? e.amount : room;
    if (amount === 0n) return;
    s.rewards += amount;
    const leftover = p.end > e.time ? (p.end - e.time) * p.rate : 0n;
    p.rate = (amount * RATE + leftover) / DRIP;
    p.end = e.time + DRIP;
    return;
  }
  const pos = positionOf(s, e.user, e.token);
  settle(p, pos);
  if (e.kind === "Staked") {
    pos.amount += e.amount;
    p.total += e.amount;
  } else {
    pos.amount -= e.amount;
    p.total -= e.amount;
  }
}

/** Everyone's Neuriio at `now`, in millionths: [{ wallet, token, minted }]. */
export function balancesAt(s, now) {
  const out = [];
  for (const [key, pos] of Object.entries(s.positions)) {
    const [wallet, token] = key.split(":");
    const p = s.pools[token];
    const earned = pos.owed + (pos.amount * (accNow(p, now) - pos.accPaid)) / ACC;
    if (earned > 0n) out.push({ wallet, token, minted: earned * NEURIIO_PER_USDC });
  }
  return out;
}

/** Bigints don't survive JSON: amounts go into the database as strings. */
export const tallyToJson = (s) => JSON.parse(JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
export function tallyFromJson(j) {
  const big = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BigInt(v)]));
  return {
    rewards: BigInt(j.rewards),
    pools: Object.fromEntries(Object.entries(j.pools).map(([k, v]) => [k, big(v)])),
    positions: Object.fromEntries(Object.entries(j.positions).map(([k, v]) => [k, big(v)])),
  };
}

/** `cfg`: { staking, feeWallet, fromBlock, confirmations, maxRange }. `store`: load() -> { next, tally } | null, and save(next, tally, changed). */
export function makeNeuriioTally({ pub, store, cfg, log = () => {} }) {
  const feeWallet = cfg.feeWallet.toLowerCase();
  const last = new Map(); // what's already saved, so only changes are sent
  const times = new Map();
  const timeOf = async (blockNumber) => {
    if (!times.has(blockNumber)) times.set(blockNumber, (await pub.getBlock({ blockNumber })).timestamp);
    return times.get(blockNumber);
  };

  async function eventOf(l) {
    const e = { kind: l.eventName, token: l.args.token.toLowerCase(), amount: l.args.amount, time: await timeOf(l.blockNumber) };
    if (l.eventName === "RewardAdded") {
      const tx = await pub.getTransaction({ hash: l.transactionHash });
      return { ...e, fromFeeWallet: tx.from.toLowerCase() === feeWallet };
    }
    return { ...e, user: l.args.user.toLowerCase() };
  }

  const changes = (tally, now) => {
    const changed = balancesAt(tally, now).filter((b) => last.get(`${b.wallet}:${b.token}`) !== b.minted);
    for (const b of changed) last.set(`${b.wallet}:${b.token}`, b.minted);
    return changed;
  };

  async function scan() {
    const head = (await pub.getBlockNumber({ cacheTime: 0 })) - BigInt(cfg.confirmations);
    const saved = await store.load();
    const tally = saved?.tally ?? emptyTally();
    let from = saved?.next ?? BigInt(cfg.fromBlock);
    if (from > head) return;
    while (from <= head) {
      const to = from + BigInt(cfg.maxRange) - 1n < head ? from + BigInt(cfg.maxRange) - 1n : head;
      const logs = await pub.getLogs({ address: cfg.staking, events: EVENTS, fromBlock: from, toBlock: to });
      logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
      for (const l of logs) applyEvent(tally, await eventOf(l));
      await store.save(to + 1n, tally, changes(tally, await timeOf(to)));
      from = to + 1n;
    }
    times.clear();
    log("neuriio", { next: from.toString(), rewards: tally.rewards.toString() });
  }

  return { scan };
}

export function memoryNeuriioStore() {
  let row = null;
  const balances = new Map();
  return {
    balances,
    load: async () => (row ? { next: row.next, tally: tallyFromJson(row.json) } : null),
    save: async (next, tally, changed) => {
      row = { next, json: tallyToJson(tally) };
      for (const b of changed) balances.set(`${b.wallet}:${b.token}`, b.minted);
    },
  };
}

/** Supabase: one call, so the tally, how far it got and the balances always move together. Migration 20261102142509_neuriio_tally.sql. */
export function supabaseNeuriioStore(url, serviceKey) {
  const api = async (path, body) => {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`supabase ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  return {
    load: async () => {
      const [row] = await api("neuriio_tally?select=next_block,state");
      return row ? { next: BigInt(row.next_block), tally: tallyFromJson(row.state) } : null;
    },
    save: (next, tally, changed) =>
      api("rpc/neuriio_save", {
        p_next_block: next.toString(),
        p_state: tallyToJson(tally),
        p_balances: changed.map((b) => ({ wallet: b.wallet, token: b.token, minted: b.minted.toString() })),
      }),
  };
}
