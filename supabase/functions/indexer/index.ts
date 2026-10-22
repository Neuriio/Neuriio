// POST /functions/v1/indexer   (run every minute by pg_cron; idempotent, so public is fine)
// Errors go to the function logs only, never into the public response: viem's errors include the RPC URL, which may
// carry an API key (security review 2026-10-22).
// 1. Elysium, for every "world" (a registry and its quote token: the old HYPE world, the USDC world):
//    Launched/FtfLaunched/Trade/Graduated from EVERY Launchpad version in the world's registry (listed on-chain,
//    re-read each run, one cursor per registry), Swapped / CurveTraded from every router of that world, and pair
//    Swaps not made via a router -> tokens (tagged with their launchpad + registry) + trades. Curve trades made
//    through the NeuriioRouter get their real trader from its CurveTraded. Writes app_config.registry = APP_REGISTRY
//    (default: the first world), which scopes what the app lists (token_stats), so a new world is indexed (charts,
//    history) before the app switches to it.
// 2. Hyperliquid: each user's fills that carry our builder fee (= placed through Neuriio) -> trades
// 3. award_points(): trades + launches -> points ledger (rates in points_rules)
//
// Secrets: WORLDS = JSON list of { registry, routers: [..], quote, decimals, usd: "hype" | "1", fromBlock }; or, for
// a single HYPE world, REGISTRY_ADDRESS + ROUTER_ADDRESSES (comma list; or ROUTER_ADDRESS) + WHYPE_ADDRESS +
// INDEX_FROM_BLOCK. APP_REGISTRY (optional), RPC_URL, HL_TESTNET ("true"/"false")

import { createClient } from "npm:@supabase/supabase-js@2";
import { createPublicClient, getAddress, http, parseAbi } from "npm:viem@2";
import {
  curveTradeToRow,
  type HlFill,
  hlFillToRow,
  ftfLaunchedToToken,
  launchedToToken,
  launchpadEvents,
  pairEvents,
  pairSwapToRow,
  poolPrice,
  type Quote,
  routerEvents,
  routerSwapToRow,
  type TradeRow,
} from "../_shared/indexer.ts";
import { json } from "../_shared/privy.ts";
import { env } from "../_shared/env.ts";


type World = { registry: `0x${string}`; routers: `0x${string}`[]; quote: `0x${string}`; decimals: number; usd: "hype" | "1"; fromBlock: bigint };
const WORLDS: World[] = Deno.env.get("WORLDS")
  // deno-lint-ignore no-explicit-any
  ? JSON.parse(Deno.env.get("WORLDS")!).map((w: any) => ({
    registry: getAddress(w.registry),
    routers: w.routers.map((r: string) => getAddress(r)),
    quote: getAddress(w.quote),
    decimals: Number(w.decimals),
    usd: w.usd === "1" ? "1" : "hype",
    fromBlock: BigInt(w.fromBlock),
  }))
  : [{
    registry: getAddress(env("REGISTRY_ADDRESS")),
    routers: (Deno.env.get("ROUTER_ADDRESSES") ?? env("ROUTER_ADDRESS")).split(",").map((a) => getAddress(a.trim())),
    quote: getAddress(env("WHYPE_ADDRESS")),
    decimals: 18,
    usd: "hype",
    fromBlock: BigInt(env("INDEX_FROM_BLOCK")),
  }];
const APP_REGISTRY = (Deno.env.get("APP_REGISTRY") ?? WORLDS[0].registry).toLowerCase();
const registryAbi = parseAbi(["function launchpadsLength() view returns (uint256)", "function launchpads(uint256) view returns (address)"]);
const HL_INFO = env("HL_TESTNET") === "true" ? "https://api.hyperliquid-testnet.xyz/info" : "https://api.hyperliquid.xyz/info";
const MAX_BLOCKS = 50_000n; // per run
const chain = createPublicClient({ transport: http(env("RPC_URL")) });
const db = createClient(env("SUPABASE_URL"), env("NEURIIO_DB_KEY"), { auth: { persistSession: false } });

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

/** Every Launchpad version ever approved in the registry (retired ones still trade their own curves). */
async function launchpads(registry: `0x${string}`): Promise<`0x${string}`[]> {
  const n = await chain.readContract({ address: registry, abi: registryAbi, functionName: "launchpadsLength" });
  return Promise.all(
    Array.from({ length: Number(n) }, (_, i) => chain.readContract({ address: registry, abi: registryAbi, functionName: "launchpads", args: [BigInt(i)] })),
  );
}

async function indexElysium(world: World, hypeUsd: number | null) {
  const registry = world.registry.toLowerCase();
  const q: Quote = { address: world.quote, decimals: world.decimals, usd: world.usd === "1" ? 1 : hypeUsd };
  const ROUTERS = world.routers;
  const IS_ROUTER = new Set(ROUTERS.map((a) => a.toLowerCase()));
  const key = `elysium:registry:${registry}`;
  const last = await getState(key);
  const from = last ? BigInt(last) + 1n : world.fromBlock;
  const head = await chain.getBlockNumber({ cacheTime: 0 });
  if (from > head) return { from: Number(from), to: Number(head), events: 0 };
  const to = head - from > MAX_BLOCKS ? from + MAX_BLOCKS : head;

  const pads = await launchpads(world.registry);
  const { data: pairsData } = await db.from("tokens").select("address, pair").eq("registry", registry).not("pair", "is", null);
  const [padLogs, routerLogs] = await Promise.all([
    pads.length ? chain.getLogs({ address: pads, events: launchpadEvents, fromBlock: from, toBlock: to }) : Promise.resolve([]),
    chain.getLogs({ address: ROUTERS, events: routerEvents, fromBlock: from, toBlock: to }),
  ]);
  // graduations in this range add pairs to watch
  const pairToken = new Map<string, string>((pairsData ?? []).map((p) => [p.pair!, p.address]));
  for (const l of padLogs) if (l.eventName === "Graduated") pairToken.set(l.args.pair!.toLowerCase(), l.args.token!.toLowerCase());
  const allPairLogs = pairToken.size
    ? await chain.getLogs({ address: [...pairToken.keys()] as `0x${string}`[], events: pairEvents, fromBlock: from, toBlock: to })
    : [];
  // swaps not made via our router (those are indexed from the router's Swapped event, which knows the trader)
  const pairLogs = allPairLogs.filter((l) => l.eventName === "Swap" && !IS_ROUTER.has(l.args.sender!.toLowerCase()));
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
    return poolPrice(a.reserve0, a.reserve1, pairToken.get(pair)!, q);
  };

  // block timestamps (few distinct blocks per run)
  const swappedLogs = routerLogs.filter((l) => l.eventName === "Swapped");
  // a curve trade made through our router: the pad's Trade names the router; the router's CurveTraded (same tx,
  // same token) names the trader
  const curveTrader = new Map<string, string>();
  for (const l of routerLogs) {
    if (l.eventName === "CurveTraded") curveTrader.set(`${l.transactionHash}:${l.args.token!.toLowerCase()}`, l.args.trader!);
  }
  const traderOf = (l: { transactionHash: string | null; args: { token?: string; trader?: string } }) =>
    IS_ROUTER.has(l.args.trader!.toLowerCase()) ? curveTrader.get(`${l.transactionHash}:${l.args.token!.toLowerCase()}`) : undefined;
  const blocks = new Set([...padLogs, ...routerLogs, ...pairLogs].map((l) => l.blockNumber!));
  const tsOf = new Map<bigint, string>();
  await Promise.all([...blocks].map(async (b) => {
    const blk = await chain.getBlock({ blockNumber: b });
    tsOf.set(b, new Date(Number(blk.timestamp) * 1000).toISOString());
  }));
  const ts = (l: { blockNumber: bigint | null }) => tsOf.get(l.blockNumber!)!;

  // tokens first (trades reference them by address only, but graduation updates need the row)
  const launched = [
    // deno-lint-ignore no-explicit-any
    ...padLogs.filter((l) => l.eventName === "Launched").map((l) => launchedToToken(l as any, ts(l), q)),
    // deno-lint-ignore no-explicit-any
    ...padLogs.filter((l) => l.eventName === "FtfLaunched").map((l) => ftfLaunchedToToken(l as any, ts(l), q)),
  ].map((t) => ({ ...t, registry }));
  if (launched.length) {
    const { error } = await db.from("tokens").upsert(launched, { onConflict: "address", ignoreDuplicates: true });
    if (error) throw new Error(`tokens: ${error.message}`);
  }
  // an FTF that launched: copy its picture + category onto the token, then close its draft (matched by ticker;
  // only one open draft per ticker)
  for (const t of launched.filter((x) => x.kind === "ftf")) {
    const { data: draft } = await db.from("ftf_drafts").select("pfp_url, category")
      .eq("status", "open").eq("ticker", t.symbol).maybeSingle(); // tickers are stored upper-case
    if (draft) {
      const { error: tErr } = await db.from("tokens").update({ pfp_url: draft.pfp_url, category: draft.category }).eq("address", t.address);
      if (tErr) throw new Error(`ftf token: ${tErr.message}`);
    }
    const { error } = await db.from("ftf_drafts")
      .update({ status: "launched", token: t.address, updated_at: new Date().toISOString() })
      .eq("status", "open").eq("ticker", t.symbol);
    if (error) throw new Error(`ftf draft: ${error.message}`);
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
    // deno-lint-ignore no-explicit-any
    ...padLogs.filter((l) => l.eventName === "Trade").map((l) => curveTradeToRow(l as any, ts(l), q, traderOf(l as any))),
    ...swappedLogs.map((l) =>
      // deno-lint-ignore no-explicit-any
      routerSwapToRow(l as any, ts(l), q, priceBefore(tokenPair.get(l.args.token!.toLowerCase()), l.transactionHash!, l.logIndex!))
    ),
    ...pairLogs.map((l) =>
      pairSwapToRow(
        // deno-lint-ignore no-explicit-any
        l as any,
        pairToken.get(l.address.toLowerCase())!,
        q,
        txFrom.get(l.transactionHash!)!,
        ts(l),
        priceBefore(l.address.toLowerCase(), l.transactionHash!, l.logIndex!),
      )
    ),
  ];
  await insertTrades(rows, "tx_hash,log_index");
  await setState(key, to.toString());
  return { registry, from: Number(from), to: Number(to), launchpads: pads.length, launched: launched.length, trades: rows.length };
}

/** Every row of a select, page by page (the API returns at most 1,000 rows per request). */
async function selectAll<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

// Hyperliquid fills only earn points, so every 10 minutes is plenty: each check asks Hyperliquid once per user (2026-10-22:
// every minute it made ~60% of all Supabase requests and most of each run's ~24 s). The cursors load in one query.
const HL_EVERY_MS = 10 * 60_000;

async function indexHyperliquid() {
  const last = Number((await getState("hl:last_run")) ?? 0);
  if (Date.now() - last < HL_EVERY_MS) return { skipped: "checked in the last 10 minutes" };
  await setState("hl:last_run", String(Date.now()));
  const [users, cursors] = await Promise.all([
    selectAll<{ wallet: string; created_at: string }>((a, b) => db.from("users").select("wallet, created_at").order("wallet").range(a, b)),
    selectAll<{ key: string; value: string }>((a, b) => db.from("indexer_state").select("key, value").like("key", "hl:0x%").order("key").range(a, b)),
  ]);
  const cursor = new Map(cursors.map((c) => [c.key, c.value]));
  let fills = 0;
  for (const u of users) {
    const key = `hl:${u.wallet}`;
    const start = Number(cursor.get(key) ?? new Date(u.created_at).getTime());
    const got: HlFill[] = await hlInfo({ type: "userFillsByTime", user: u.wallet, startTime: start, aggregateByTime: false });
    if (!got.length) continue;
    const rows = got.map((f) => hlFillToRow(f, u.wallet)).filter((r): r is TradeRow => r !== null);
    await insertTrades(rows, "hl_tid");
    fills += rows.length;
    await setState(key, String(Math.max(...got.map((f) => f.time)) + 1));
  }
  return { users: users.length, fills };
}

Deno.serve(async () => {
  // one run at a time; skips if another started < 50 s ago
  const { data: locked, error: lockErr } = await db.rpc("try_lock_indexer");
  if (lockErr) {
    console.error(`indexer: lock: ${lockErr.message}`);
    return json(500, { error: "failed" });
  }
  if (!locked) return json(200, { skipped: "another run is in progress" });

  /** Logs the details; the caller only learns that this part failed. */
  const failed = (what: string, e: unknown) => {
    console.error(`indexer: ${what}: ${(e as Error)?.message ?? e}`);
    return "failed";
  };
  const result: Record<string, unknown> = {};
  try {
    const usd = await hypeUsd();
    result.hypeUsd = usd;
    // the registry the app shows (token_stats reads it)
    const { error: cfgErr } = await db.from("app_config").upsert({ key: "registry", value: APP_REGISTRY, updated_at: new Date().toISOString() });
    if (cfgErr) throw new Error(`app_config: ${cfgErr.message}`);
    result.elysium = [];
    for (const w of WORLDS) {
      try {
        (result.elysium as unknown[]).push(await indexElysium(w, usd));
      } catch (e) {
        (result.elysium as unknown[]).push({ registry: w.registry, error: failed(`elysium ${w.registry}`, e) });
      }
    }
  } catch (e) {
    result.elysiumError = failed("elysium", e);
  }
  try {
    result.hyperliquid = await indexHyperliquid();
  } catch (e) {
    result.hyperliquidError = failed("hyperliquid", e);
  }
  const { data: awarded, error } = await db.rpc("award_points");
  result.pointsAwarded = error ? failed("award_points", error) : awarded;
  await db.rpc("unlock_indexer");
  return json(200, result);
});
