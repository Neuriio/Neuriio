// Top holders (user, 2026-11-08): every holder's balance per coin, from the coin's own Transfer events (our own chain data, no
// explorer). Runs in the launch-check service every 5 minutes for the same coins (our launches + Explore's Verified top 15).
// First time per coin: all transfers since its launch (10,000-block steps). After that: only the blocks since the last pass, one
// log search per coin. Each range's balance changes are applied with the cursor in one transaction (holders_apply), and only if
// the range continues the cursor, so nothing is ever counted twice.
import { parseAbiItem } from "viem";
import { logsAcross } from "../launchcheck/check.mjs";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a) => a.toLowerCase();

/** Balance changes from a list of Transfer logs: holder -> delta (BigInt). Mints come from 0x0, so 0x0 is never a holder. */
export function deltasOf(logs) {
  const d = new Map();
  const add = (a, v) => d.set(a, (d.get(a) ?? 0n) + v);
  for (const l of logs) {
    const { from, to, value } = l.args;
    if (value === 0n) continue;
    if (lc(from) !== ZERO) add(lc(from), -value);
    if (lc(to) !== ZERO) add(lc(to), value);
  }
  for (const [a, v] of d) if (v === 0n) d.delete(a);
  return d;
}

/** `cfg`: { confirmations (2), applyEvery (500000 blocks per apply) }. `store`: tokens(), scans() -> Map token -> scannedTo,
 *  apply(token, from, to, deltas Map) -> bool. */
export function makeHolderScanner({ pub, store, cfg = {}, log = () => {} }) {
  const confirmations = BigInt(cfg.confirmations ?? 2);
  const applyEvery = BigInt(cfg.applyEvery ?? 500_000);
  return {
    async pass() {
      const [tokens, scans] = await Promise.all([store.tokens(), store.scans()]);
      const head = (await pub.getBlockNumber({ cacheTime: 0 })) - confirmations;
      for (const t of tokens) {
        const token = lc(t.token);
        try {
          let from = scans.has(token) ? BigInt(scans.get(token)) + 1n : BigInt(t.launchBlock);
          let applied = 0;
          while (from <= head) {
            const to = from + applyEvery - 1n < head ? from + applyEvery - 1n : head;
            const logs = await logsAcross(pub, { address: t.token, event: TRANSFER }, from, to);
            if (!(await store.apply(token, from, to, deltasOf(logs)))) {
              log("holders_skipped", { token, from: from.toString(), why: "range isn't next: another pass got there first" });
              break;
            }
            applied += logs.length;
            from = to + 1n;
          }
          if (applied) log("holders", { token, transfers: applied });
        } catch (e) {
          log("error", { in: "holders", token, error: e.shortMessage ?? e.message });
        }
      }
    },
  };
}

/** For tests: the same rules as holders_apply in memory. */
export function memoryHolderStore(tokens = []) {
  const balances = new Map(); // token -> Map holder -> BigInt
  const scans = new Map();
  return {
    balances,
    scansMap: scans,
    tokens: async () => tokens,
    scans: async () => new Map(scans),
    apply: async (token, from, to, deltas) => {
      const cur = scans.get(token);
      if ((cur === undefined && balances.has(token)) || (cur !== undefined && BigInt(from) !== BigInt(cur) + 1n)) return false;
      const b = balances.get(token) ?? new Map();
      for (const [h, v] of deltas) {
        const n = (b.get(h) ?? 0n) + v;
        if (n === 0n) b.delete(h);
        else b.set(h, n);
      }
      balances.set(token, b);
      scans.set(token, BigInt(to));
      return true;
    },
  };
}

/** Supabase, with the service key. Migration 20261108090000_token_holders.sql. `tokens` = the launch check store's list. */
export function supabaseHolderStore(url, serviceKey, tokens) {
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
    tokens,
    scans: async () => new Map((await api("holder_scans?select=token,scanned_to")).map((r) => [r.token, BigInt(r.scanned_to)])),
    apply: async (token, from, to, deltas) =>
      api("rpc/holders_apply", {
        method: "POST",
        body: JSON.stringify({
          p_token: token,
          p_from: Number(from),
          p_to: Number(to),
          p_deltas: [...deltas].map(([holder, delta]) => ({ holder, delta: delta.toString() })),
        }),
      }),
  };
}
