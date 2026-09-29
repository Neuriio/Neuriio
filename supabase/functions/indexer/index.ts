// POST /functions/v1/indexer   (run every minute by pg_cron; idempotent, so public is fine)
// 1. Elysium: Launchpad Launched/Trade/Graduated, SwapRouter Swapped, and pair Swaps not made via our router
//    -> tokens + trades
// 2. Hyperliquid: each user's fills that carry our builder fee (= placed through Neuriio) -> trades
// 3. award_points(): trades + launches -> points ledger (rates in points_rules)
//
// Secrets: LAUNCHPAD_ADDRESS, ROUTER_ADDRESS, WHYPE_ADDRESS, INDEX_FROM_BLOCK, RPC_URL, HL_TESTNET ("true"/"false")

import { createClient } from "npm:@supabase/supabase-js@2";
import { createPublicClient, getAddress, http } from "npm:viem@2";
import {
  curveTradeToRow,
  type HlFill,
  hlFillToRow,
  launchedToToken,
  launchpadEvents,
  pairEvents,
  pairSwapToRow,
  poolPrice,
  routerEvents,
  routerSwapToRow,
  type TradeRow,
} from "../_shared/indexer.ts";
import { json } from "../_shared/privy.ts";
import { env } from "../_shared/env.ts";


const LAUNCHPAD = getAddress(env("LAUNCHPAD_ADDRESS"));
const ROUTER = getAddress(env("ROUTER_ADDRESS"));
const WHYPE = getAddress(env("WHYPE_ADDRESS"));
const FROM_BLOCK = BigInt(env("INDEX_FROM_BLOCK"));
const HL_INFO = env("HL_TESTNET") === "true" ? "https://api.hyperliquid-testnet.xyz/info" : "https://api.hyperliquid.xyz/info";
const MAX_BLOCKS = 50_000n; // per run
const chain = createPublicClient({ transport: http(env("RPC_URL")) });
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const hlInfo = async (body: unknown) => {
  const res = await fetch(HL_INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}`);
  return res.json();
};

/** HYPE in USD from Hyperliquid MAINNET (testnet prices are meaningless); null if unavailable. */
async function hypeUsd(): Promise<number | null> {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    const px = Number((await res.json()).HYPE);
    return px > 0 ? px : null;
  } catch {
    return null;
  }
}

async function getState(key: string): Promise<string | null> {
  const { data } = await db.from("indexer_state").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
async function setState(key: string, value: string) {
  const { error } = await db.from("indexer_state").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`state ${key}: ${error.message}`);
}
async function insertTrades(rows: TradeRow[], onConflict: string) {
  if (!rows.length) return;
  const { error } = await db.from("trades").upsert(rows, { onConflict, ignoreDuplicates: true });
  if (error) throw new Error(`trades: ${error.message}`);
}

async function indexElysium(usd: number | null) {
  const key = `elysium:${LAUNCHPAD.toLowerCase()}`;
  const last = await getState(key);
  const from = last ? BigInt(last) + 1n : FROM_BLOCK;
  const head = await chain.getBlockNumber({ cacheTime: 0 });
  if (from > head) return { from: Number(from), to: Number(head), events: 0 };
  const to = head - from > MAX_BLOCKS ? from + MAX_BLOCKS : head;

  const { data: pairsData } = await db.from("tokens").select("address, pair").not("pair", "is", null);
  const [padLogs, routerLogs] = await Promise.all([
    chain.getLogs({ address: LAUNCHPAD, events: launchpadEvents, fromBlock: from, toBlock: to }),
    chain.getLogs({ address: ROUTER, events: routerEvents, fromBlock: from, toBlock: to }),
  ]);
  // graduations in this range add pairs to watch
  const pairToken = new Map<string, string>((pairsData ?? []).map((p) => [p.pair!, p.address]));
  for (const l of padLogs) if (l.eventName === "Graduated") pairToken.set(l.args.pair!.toLowerCase(), l.args.token!.toLowerCase());
  const allPairLogs = pairToken.size
    ? await chain.getLogs({ address: [...pairToken.keys()] as `0x${string}`[], events: pairEvents, fromBlock: from, toBlock: to })
    : [];
  // swaps not made via our router (those are indexed from the router's Swapped event, which knows the trader)
  const pairLogs = allPairLogs.filter((l) => l.eventName === "Swap" && l.args.sender!.toLowerCase() !== ROUTER.toLowerCase());
  // pool price after a swap = the last Sync of that pair before the given log in the same tx
  const syncs = allPairLogs.filter((l) => l.eventName === "Sync");
  const tokenPair = new Map([...pairToken].map(([pair, token]) => [token, pair]));
  const priceBefore = (pair: string | undefined, tx: string, logIndex: number) => {
    let best: (typeof syncs)[number] | undefined;
    for (const l of syncs) {
      if (l.transactionHash === tx && l.address.toLowerCase() === pair && l.logIndex! < logIndex && (!best || l.logIndex! > best.logIndex!)) best = l;
    }
    if (!best || !pair) return null;
    // deno-lint-ignore no-explicit-any
    const a = best.args as any;
    return poolPrice(a.reserve0, a.reserve1, pairToken.get(pair)!, WHYPE);
  };

  // block timestamps (few distinct blocks per run)
  const blocks = new Set([...padLogs, ...routerLogs, ...pairLogs].map((l) => l.blockNumber!));
  const tsOf = new Map<bigint, string>();
  await Promise.all([...blocks].map(async (b) => {
    const blk = await chain.getBlock({ blockNumber: b });
    tsOf.set(b, new Date(Number(blk.timestamp) * 1000).toISOString());
  }));
  const ts = (l: { blockNumber: bigint | null }) => tsOf.get(l.blockNumber!)!;

  // tokens first (trades reference them by address only, but graduation updates need the row)
  const launched = padLogs.filter((l) => l.eventName === "Launched")
    // deno-lint-ignore no-explicit-any
    .map((l) => launchedToToken(l as any, ts(l)));
  if (launched.length) {
    const { error } = await db.from("tokens").upsert(launched, { onConflict: "address", ignoreDuplicates: true });
    if (error) throw new Error(`tokens: ${error.message}`);
  }
  for (const l of padLogs.filter((l) => l.eventName === "Graduated")) {
    const { error } = await db.from("tokens")
      .update({ graduated: true, pair: l.args.pair!.toLowerCase(), graduated_at: ts(l) })
      .eq("address", l.args.token!.toLowerCase());
    if (error) throw new Error(`graduate: ${error.message}`);
  }

  const txFrom = new Map<string, string>();
  await Promise.all([...new Set(pairLogs.map((l) => l.transactionHash!))].map(async (h) => {
    txFrom.set(h, (await chain.getTransaction({ hash: h })).from);
  }));
  const rows: TradeRow[] = [
    // deno-lint-ignore no-explicit-any
    ...padLogs.filter((l) => l.eventName === "Trade").map((l) => curveTradeToRow(l as any, ts(l), usd)),
    // deno-lint-ignore no-explicit-any
    ...routerLogs.map((l) =>
      // deno-lint-ignore no-explicit-any
      routerSwapToRow(l as any, ts(l), usd, priceBefore(tokenPair.get(l.args.token!.toLowerCase()), l.transactionHash!, l.logIndex!))
    ),
    ...pairLogs.map((l) =>
      pairSwapToRow(
        // deno-lint-ignore no-explicit-any
        l as any,
        pairToken.get(l.address.toLowerCase())!,
        WHYPE,
        txFrom.get(l.transactionHash!)!,
        ts(l),
        usd,
        priceBefore(l.address.toLowerCase(), l.transactionHash!, l.logIndex!),
      )
    ),
  ];
  await insertTrades(rows, "tx_hash,log_index");
  await setState(key, to.toString());
  return { from: Number(from), to: Number(to), launched: launched.length, trades: rows.length };
}

async function indexHyperliquid() {
  const { data: users, error } = await db.from("users").select("wallet, created_at");
  if (error) throw new Error(`users: ${error.message}`);
  let fills = 0;
  for (const u of users ?? []) {
    const key = `hl:${u.wallet}`;
    const start = Number(await getState(key) ?? new Date(u.created_at).getTime());
    const got: HlFill[] = await hlInfo({ type: "userFillsByTime", user: u.wallet, startTime: start, aggregateByTime: false });
    if (!got.length) continue;
    const rows = got.map((f) => hlFillToRow(f, u.wallet)).filter((r): r is TradeRow => r !== null);
    await insertTrades(rows, "hl_tid");
    fills += rows.length;
    await setState(key, String(Math.max(...got.map((f) => f.time)) + 1));
  }
  return { users: users?.length ?? 0, fills };
}

Deno.serve(async () => {
  // one run at a time; skips if another started < 50 s ago
  const { data: locked, error: lockErr } = await db.rpc("try_lock_indexer");
  if (lockErr) return json(500, { error: lockErr.message });
  if (!locked) return json(200, { skipped: "another run is in progress" });

  const result: Record<string, unknown> = {};
  try {
    const usd = await hypeUsd();
    result.hypeUsd = usd;
    result.elysium = await indexElysium(usd);
  } catch (e) {
    result.elysiumError = (e as Error).message;
  }
  try {
    result.hyperliquid = await indexHyperliquid();
  } catch (e) {
    result.hyperliquidError = (e as Error).message;
  }
  const { data: awarded, error } = await db.rpc("award_points");
  result.pointsAwarded = error ? `error: ${error.message}` : awarded;
  await db.rpc("unlock_indexer");
  return json(200, result);
});
