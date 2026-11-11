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
// 2b. Creator fees (creatorFees.ts): each tracked token's Ascend escrow -> creator_fees, every 5 minutes.
// 3. link_trades(): tags new trades with their trader's X account. Trader activity is kept for how Neuriio will be earned
//    (first piece: user, 2026-11-01); it isn't displayed anywhere.
//
// 1b. An "ascend" world (Elysium mainnet, user 2026-11-04): launches from our NeuriioLauncher (Launched/FtfLaunched, each with its
//    Ascend pool id) and every Swap in those pools from Ascend's Uniswap v4 PoolManager, with the fee from the Ascend launchpad's
//    HookSwap; the trader is the transaction's sender (HookSwap's sender is the router).
// 1c. An "ascend_all" world (/trending, user 2026-11-04): EVERY coin launched on Ascend (the launchpad's Launched), and every
//    swap and standing-bid fill in their pools, priced in USD (pairs from Hyperliquid spot) -> ascend_tokens + trades; plus
//    each coin's art from Ascend's public metadata API.
//
// Secrets: WORLDS = JSON list of { registry, routers: [..], quote, decimals, usd: "hype" | "1", fromBlock } or, for mainnet,
// { kind: "ascend", launcher, poolManager, hook, quote, decimals, fromBlock } and { kind: "ascend_all", poolManager, hook,
// fromBlock (Ascend's deployment block, 422319) }; or, for
// a single HYPE world, REGISTRY_ADDRESS + ROUTER_ADDRESSES (comma list; or ROUTER_ADDRESS) + WHYPE_ADDRESS +
// INDEX_FROM_BLOCK. APP_REGISTRY (optional), RPC_URL, HL_TESTNET ("true"/"false")

import { createClient } from "npm:@supabase/supabase-js@2";
import { createPublicClient, getAddress, http, parseAbi } from "npm:viem@2";
import {
  ascendLaunched,
  ascendLaunchedToRow,
  ascendSwapToRow,
  bidFilled,
  metadataColumns,
  pairUsd,
  rowInUsd,
  type SpotMeta,
  curveTradeToRow,
  hookFeesByTx,
  hookSwap,
  launcherEvents,
  launcherFtfLaunchedToToken,
  launcherLaunchedToToken,
  poolManagerSwap,
  withBidFills,
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
import { indexCreatorFees } from "./creatorFees.ts";
import { env } from "../_shared/env.ts";


type World = { kind?: "pad"; registry: `0x${string}`; routers: `0x${string}`[]; quote: `0x${string}`; decimals: number; usd: "hype" | "1"; fromBlock: bigint };
type AscendAllWorld = { kind: "ascend_all"; registry: `0x${string}`; poolManager: `0x${string}`; hook: `0x${string}`; fromBlock: bigint };
type AscendWorld = { kind: "ascend"; registry: `0x${string}`; poolManager: `0x${string}`; hook: `0x${string}`; quote: `0x${string}`; decimals: number; fromBlock: bigint };
const WORLDS: (World | AscendWorld | AscendAllWorld)[] = Deno.env.get("WORLDS")
  // deno-lint-ignore no-explicit-any
  ? JSON.parse(Deno.env.get("WORLDS")!).map((w: any) => w.kind === "ascend_all" ? {
    kind: "ascend_all",
    registry: getAddress(w.hook), // not an app registry: only the cursor's name
    poolManager: getAddress(w.poolManager),
    hook: getAddress(w.hook),
    fromBlock: BigInt(w.fromBlock),
  } : w.kind === "ascend" ? {
    kind: "ascend",
    registry: getAddress(w.launcher), // the launcher is this world's registry: token_stats lists what it launched
    poolManager: getAddress(w.poolManager),
    hook: getAddress(w.hook),
    quote: getAddress(w.quote),
    decimals: Number(w.decimals),
    fromBlock: BigInt(w.fromBlock),
  } : ({
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
// Explore's list and charts for every Ascend coin come from our own chain data (user, 2026-11-07: "just track the chain", no
// Agora): with an "ascend" world and no "ascend_all" one in WORLDS, add it (every 5 minutes, see indexAscendAll).
{
  const ours = WORLDS.find((w) => w.kind === "ascend") as AscendWorld | undefined;
  if (ours && !WORLDS.some((w) => w.kind === "ascend_all")) {
    WORLDS.push({ kind: "ascend_all", registry: ours.hook, poolManager: ours.poolManager, hook: ours.hook, fromBlock: 422_319n });
  }
}
/** NeuriioSwap (trading tokens launched elsewhere): its trades' traders are recorded for Positions (comma list). */
const NEURIIO_SWAPS = (Deno.env.get("NEURIIO_SWAPS") ?? "0x630B8f610abEAe77FD39f802136F57Dd2B2f4946").split(",").map((a) => getAddress(a.trim()));
// with only the ascend_all world (before our launcher is deployed) there's no app registry: nothing is "ours" yet
const APP_REGISTRY = (Deno.env.get("APP_REGISTRY") ?? WORLDS.find((w) => w.kind !== "ascend_all")?.registry ?? "0x0000000000000000000000000000000000000000").toLowerCase();
const registryAbi = parseAbi(["function launchpadsLength() view returns (uint256)", "function launchpads(uint256) view returns (address)"]);
const HL_INFO = env("HL_TESTNET") === "true" ? "https://api.hyperliquid-testnet.xyz/info" : "https://api.hyperliquid.xyz/info";
// blocks per getLogs, minus one (`to = from + MAX_BLOCKS`, both ends included): Alchemy refuses ranges over 10,000 blocks.
// It was 50,000: once a DB outage (2026-11-08 22:21) left a gap over 10,000 blocks, every run failed and the world froze.
const MAX_BLOCKS = 9_999n;
const OURS_EVERY_MS = 5 * 60_000;
const OURS_RUN_MS = 20_000; // our launcher's world catches up chunk after chunk for this long, then stops until the next run
const chain = createPublicClient({ transport: http(env("RPC_URL")) });
const db = createClient(env("SUPABASE_URL"), env("NEURIIO_DB_KEY"), { auth: { persistSession: false } });
/** The chain head, remembered: the run ends by publishing the latest one (app_config.elysium_head: the site footer's block). */
let seenHead = 0n;
async function headNow() {
  const h = await chain.getBlockNumber({ cacheTime: 0 });
  if (h > seenHead) seenHead = h;
  return h;
}

const hlInfo = async (body: unknown) => {
  // 5 s at most: with no timeout a stalled Hyperliquid (429s, 2026-11-11) ate the Ascend world's whole 30 s and it indexed nothing
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
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
  const head = await headNow();
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

/** The Ascend world: our launcher's launches, then the swaps in their Ascend pools (ids filtered on the event's indexed topic,
 *  in chunks, so we never read the rest of Ascend's market). */
async function indexAscend(world: AscendWorld) {
  // caught up: every 5 minutes (user, 2026-11-11: RPC cost; every minute was ~11M Alchemy CU a month). Trades made on Neuriio
  // arrive at once via record-trade; a new launch can take up to 5 minutes to show in Explore (the "is live" screen reads the chain).
  const registry = world.registry.toLowerCase();
  const last = await getState(`elysium:registry:${registry}`);
  const lastAt = Number((await getState(`elysium:registry:${registry}:at`)) ?? 0);
  if (last && (await headNow()) - BigInt(last) < ALL_CAUGHT_UP && Date.now() - lastAt < OURS_EVERY_MS) {
    return { registry, skipped: "ran in the last 5 minutes" };
  }
  await setState(`elysium:registry:${registry}:at`, String(Date.now()));
  const started = Date.now();
  const steps = [];
  for (;;) {
    const r = await indexAscendStep(world);
    steps.push(r);
    if (r.to >= r.head || Date.now() - started > OURS_RUN_MS) return { ...r, from: steps[0].from, steps: steps.length };
  }
}

/** One range of at most MAX_BLOCKS + 1 blocks from the saved place (saved again at the end). */
async function indexAscendStep(world: AscendWorld) {
  const registry = world.registry.toLowerCase();
  const q: Quote = { address: world.quote, decimals: world.decimals, usd: 1 };
  const key = `elysium:registry:${registry}`;
  const last = await getState(key);
  const from = last ? BigInt(last) + 1n : world.fromBlock;
  const head = await headNow();
  if (from > head) return { registry, from: Number(from), to: Number(head), head: Number(head), events: 0 };
  const to = head - from > MAX_BLOCKS ? from + MAX_BLOCKS : head;

  const launchLogs = await chain.getLogs({ address: world.registry, events: launcherEvents, fromBlock: from, toBlock: to });
  const blocks = new Set<bigint>(launchLogs.map((l) => l.blockNumber!));
  const tsOf = new Map<bigint, string>();
  const stamp = (bs: Set<bigint>) =>
    Promise.all([...bs].filter((b) => !tsOf.has(b)).map(async (b) => {
      const blk = await chain.getBlock({ blockNumber: b });
      tsOf.set(b, new Date(Number(blk.timestamp) * 1000).toISOString());
    }));
  await stamp(blocks);
  const ts = (l: { blockNumber: bigint | null }) => tsOf.get(l.blockNumber!)!;

  const launched = [
    // deno-lint-ignore no-explicit-any
    ...launchLogs.filter((l) => l.eventName === "Launched").map((l) => launcherLaunchedToToken(l as any, ts(l))),
    // deno-lint-ignore no-explicit-any
    ...launchLogs.filter((l) => l.eventName === "FtfLaunched").map((l) => launcherFtfLaunchedToToken(l as any, ts(l))),
  ].map((t) => ({ ...t, registry }));
  if (launched.length) {
    const { error } = await db.from("tokens").upsert(launched, { onConflict: "address", ignoreDuplicates: true });
    if (error) throw new Error(`tokens: ${error.message}`);
  }
  for (const t of launched.filter((x) => x.kind === "ftf")) await closeFtfDraft(t.address, t.symbol);

  // every pool of ours: what's stored, plus what launched in this range
  const stored = await selectAll<{ address: string; pair: string }>((a, b) =>
    db.from("tokens").select("address, pair").eq("registry", registry).not("pair", "is", null).order("address").range(a, b)
  );
  const tokenOfPool = new Map<string, string>(stored.map((t) => [t.pair.toLowerCase(), t.address]));
  for (const t of launched) tokenOfPool.set(t.pair, t.address);
  const ids = [...tokenOfPool.keys()] as `0x${string}`[];
  const swaps = [];
  const hooks = [];
  const fills = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const [s, h, f] = await Promise.all([
      chain.getLogs({ address: world.poolManager, event: poolManagerSwap, args: { id: chunk }, fromBlock: from, toBlock: to }),
      chain.getLogs({ address: world.hook, event: hookSwap, args: { poolId: chunk }, fromBlock: from, toBlock: to }),
      chain.getLogs({ address: world.hook, event: bidFilled, args: { poolId: chunk }, fromBlock: from, toBlock: to }),
    ]);
    swaps.push(...s);
    hooks.push(...h);
    fills.push(...f);
  }
  await stamp(new Set([...swaps, ...fills].map((l) => l.blockNumber!)));
  const txFrom = new Map<string, string>();
  await Promise.all([...new Set([...swaps, ...fills].map((l) => l.transactionHash!))].map(async (h) => {
    txFrom.set(h, (await chain.getTransaction({ hash: h })).from);
  }));
  // deno-lint-ignore no-explicit-any
  const fees = hookFeesByTx(hooks as any, tokenOfPool, q);
  const seen = new Map<string, number>();
  const swapRows: TradeRow[] = [...swaps].sort((x, y) => Number(x.blockNumber! - y.blockNumber!) || x.logIndex! - y.logIndex!).map((l) => {
    const pool = l.args.id!.toLowerCase();
    const k = `${l.transactionHash}:${pool}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    const fee = fees.get(k)?.[n] ?? null;
    // deno-lint-ignore no-explicit-any
    return ascendSwapToRow(l as any, tokenOfPool.get(pool)!, q, txFrom.get(l.transactionHash!)!, ts(l), fee);
  });
  // a pool's standing bid can take part (or all) of a sell: add it to that sell, or store it as one
  // deno-lint-ignore no-explicit-any
  const rows = withBidFills(swapRows, fills as any, tokenOfPool, q, txFrom, ts as any);
  await insertTrades(rows, "tx_hash,log_index");
  await setState(key, to.toString());
  return { registry, from: Number(from), to: Number(to), head: Number(head), launched: launched.length, trades: rows.length };
}

const erc20Views = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
// Mainnet blocks are ~0.2 s and busy stretches carry ~4,000 trades per 20,000 blocks (measured 2026-11-05), so a run works in
// small chunks for a fixed time and saves its place after each; the backfill from Ascend's deployment takes a few hours.
const ALL_LOG_STEP = 2_000n; // blocks per chunk: one getLogs per event, inside providers' range limits (Alchemy: 10,000)
const ALL_RUN_MS = 30_000; // chunk after chunk for this long, then stop (the cron runs every minute)
const LOOKUPS_AT_ONCE = 6; // each trade's trader is its transaction's sender: one lookup per transaction, a few at a time
const METADATA_PER_RUN = 25;
const ALL_EVERY_MS = 5 * 60_000;
const ALL_CAUGHT_UP = 3_000n; // blocks (~10 minutes): behind more than this, every run keeps catching up
const ALL_MIN_STEP = 50n; // smallest chunk when responses are too big
/** The provider (or viem) refused a response for its size or its number of results: a smaller block range will do. */
const tooBig = (e: unknown) =>
  /size limit|response size|too large|more than \d+ results|query returned more than/i.test(String((e as Error)?.message ?? e));

/** Runs `f` over `items`, at most `n` at a time, so a busy stretch never fires thousands of requests at the provider at once. */
async function eachLimit<T>(items: T[], n: number, f: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await f(items[i++]);
  }));
}
const quoteInfo = new Map<string, { symbol: string | null; decimals: number }>();

/** Every Ascend coin: launches, then the swaps and bid fills in all their pools (read whole, then kept to Ascend pools), in USD. */
async function indexAscendAll(world: AscendAllWorld, hypeUsdNow: number | null) {
  const key = "elysium:ascend_all";
  const last = await getState(key);
  const first = last ? BigInt(last) + 1n : world.fromBlock;
  const head = await headNow();
  if (first > head) return { world: "ascend_all", from: Number(first), to: Number(head), events: 0 };
  // caught up: every 5 minutes is enough (list numbers, chart history); Neuriio's own trades arrive at once via record-trade
  const lastAt = Number((await getState("elysium:ascend_all:at")) ?? 0);
  if (head - first < ALL_CAUGHT_UP && Date.now() - lastAt < ALL_EVERY_MS) return { world: "ascend_all", skipped: "ran in the last 5 minutes" };
  await setState("elysium:ascend_all:at", String(Date.now()));

  // USD per pair asset, as Ascend's app prices them (Hyperliquid spot vs USDC): once per run
  const [meta, mids] = await Promise.all([
    hlInfo({ type: "spotMeta" }).catch(() => null) as Promise<SpotMeta | null>,
    hlInfo({ type: "allMids" }).catch(() => null) as Promise<Record<string, string> | null>,
  ]);
  const usdOf = (t: { quote_symbol: string | null }) => {
    const sym = t.quote_symbol?.toUpperCase();
    return sym === "WHYPE" && hypeUsdNow ? hypeUsdNow : pairUsd(t.quote_symbol, meta, mids);
  };

  // A very busy stretch can make one event's logs over the 10 MB response limit (2026-11-09 17:40, Kinetiq's launch day: 2,000
  // blocks of PoolManager swaps froze the world for 33 hours). Then the chunk is halved and tried again (chunks are idempotent:
  // upserts that skip duplicates), and grows back after each success.
  let from = first, launched = 0, trades = 0, step = ALL_LOG_STEP;
  const loopStart = Date.now(); // the 30 s budget counts from here, not from before the price fetches above
  while (from <= head && Date.now() - loopStart < ALL_RUN_MS) {
    const to = from + step - 1n < head ? from + step - 1n : head;
    let r;
    try {
      r = await indexAscendChunk(world, from, to, usdOf);
    } catch (e) {
      if (step > ALL_MIN_STEP && tooBig(e)) {
        step /= 2n;
        continue;
      }
      throw e;
    }
    launched += r.launched;
    trades += r.trades;
    await setState(key, to.toString());
    from = to + 1n;
    if (step < ALL_LOG_STEP) step *= 2n;
  }
  const art = await fetchAscendArt();
  return { world: "ascend_all", from: Number(first), to: Number(from - 1n), head: Number(head), launched, trades, art };
}

/** One chunk of blocks: its launches, then the swaps and bid fills in every Ascend pool, as trade rows in USD. */
async function indexAscendChunk(world: AscendAllWorld, from: bigint, to: bigint, usdOf: (t: { quote_symbol: string | null }) => number | null) {
  // 1. launches
  const launches = await chain.getLogs({ address: world.hook, event: ascendLaunched, fromBlock: from, toBlock: to });
  // block times: from the logs themselves when the provider includes them (Alchemy does), else one lookup per block
  const tsOf = new Map<bigint, string>();
  const stamp = async (logs: { blockNumber: bigint | null; blockTimestamp?: bigint | null }[]) => {
    for (const l of logs) if (l.blockTimestamp != null) tsOf.set(l.blockNumber!, new Date(Number(l.blockTimestamp) * 1000).toISOString());
    const missing = [...new Set(logs.map((l) => l.blockNumber!))].filter((b) => !tsOf.has(b));
    await eachLimit(missing, LOOKUPS_AT_ONCE, async (b) => {
      const blk = await chain.getBlock({ blockNumber: b });
      tsOf.set(b, new Date(Number(blk.timestamp) * 1000).toISOString());
    });
  };
  await stamp(launches);
  const read = (address: `0x${string}`, functionName: "name" | "symbol" | "decimals" | "totalSupply") =>
    // deno-lint-ignore no-explicit-any
    chain.readContract({ address, abi: erc20Views, functionName } as any).catch(() => null);
  const rows = [];
  for (const l of launches) {
    const q = l.args.quote!.toLowerCase();
    if (!quoteInfo.has(q)) {
      const [sym, dec] = await Promise.all([read(l.args.quote!, "symbol"), read(l.args.quote!, "decimals")]);
      quoteInfo.set(q, { symbol: (sym as string) ?? null, decimals: Number(dec ?? 18) });
    }
    const [name, symbol, supply] = await Promise.all([read(l.args.token!, "name"), read(l.args.token!, "symbol"), read(l.args.token!, "totalSupply")]);
    // deno-lint-ignore no-explicit-any
    rows.push(ascendLaunchedToRow(l as any, tsOf.get(l.blockNumber!)!, {
      name: (name as string) ?? null,
      symbol: (symbol as string) ?? null,
      supply: supply == null ? undefined : Number(BigInt(supply as bigint) / 10n ** 18n),
    }, quoteInfo.get(q)!));
  }
  if (rows.length) {
    const { error } = await db.from("ascend_tokens").upsert(rows, { onConflict: "address", ignoreDuplicates: true });
    if (error) throw new Error(`ascend_tokens: ${error.message}`);
  }

  // 2. every Ascend pool we know, and this range's swaps, fees and bid fills in them
  const known = await selectAll<{ address: string; pool_id: string; quote: string; quote_symbol: string | null; quote_decimals: number }>((a, b) =>
    db.from("ascend_tokens").select("address, pool_id, quote, quote_symbol, quote_decimals").order("address").range(a, b)
  );
  const poolInfo = new Map(known.map((t) => [t.pool_id, t]));
  const tokenOfPool = new Map(known.map((t) => [t.pool_id, t.address]));
  const inPools = <L extends { args: Record<string, unknown> }>(logs: L[], field: string) =>
    logs.filter((l) => poolInfo.has(String(l.args[field]).toLowerCase()));
  // The hook's own events first: every swap in an Ascend pool also emits the hook's HookSwap (checked 2026-11-11: 21 PoolManager
  // swaps in Ascend pools = 21 HookSwaps, same 14 pools), so they name the pools that traded. Then the PoolManager's Swap only
  // for those pools (indexed id topic, 50 at a time): reading it whole meant decoding every swap on Elysium, and one non-Ascend
  // pool (0xbc0e43c8…) does ~117 swaps a block (58k logs / 56 MB per 500 blocks), which ran the function out of CPU time.
  const [hooks, fills] = await Promise.all([
    chain.getLogs({ address: world.hook, event: hookSwap, fromBlock: from, toBlock: to }).then((l) => inPools(l, "poolId")),
    chain.getLogs({ address: world.hook, event: bidFilled, fromBlock: from, toBlock: to }).then((l) => inPools(l, "poolId")),
  ]);
  const traded = [...new Set(hooks.map((l) => String(l.args.poolId).toLowerCase()))] as `0x${string}`[];
  const swaps = [];
  for (let i = 0; i < traded.length; i += 50) {
    swaps.push(...await chain.getLogs({ address: world.poolManager, event: poolManagerSwap, args: { id: traded.slice(i, i + 50) }, fromBlock: from, toBlock: to }));
  }
  await stamp([...swaps, ...fills]);
  // the trader (each transaction's sender) costs one lookup per trade, most of this world's RPC bill (user, 2026-11-05: keep it
  // ~10-15M Alchemy compute units a month), so only our own launches get it; others' trades are stored with trader ""
  const ours = new Set((await selectAll<{ address: string }>((a, b) => db.from("tokens").select("address").order("address").range(a, b))).map((t) => t.address));
  const poolIsOurs = (l: { args: Record<string, unknown> }) => ours.has(tokenOfPool.get(String(l.args.id ?? l.args.poolId).toLowerCase()) ?? "");
  // ...plus every trade made through NeuriioSwap (Positions shows those too): its events name the transactions
  const viaSwap = new Set((await chain.getLogs({ address: NEURIIO_SWAPS, fromBlock: from, toBlock: to })).map((l) => l.transactionHash!));
  const txFrom = new Map<string, string>();
  await eachLimit([...new Set([...swaps, ...fills].filter((l) => poolIsOurs(l) || viaSwap.has(l.transactionHash!)).map((l) => l.transactionHash!))], LOOKUPS_AT_ONCE, async (h) => {
    txFrom.set(h, (await chain.getTransaction({ hash: h })).from);
  });

  // 3. trades, pair by pair (each pool's pair sets its units), then in USD
  const ts = (l: { blockNumber: bigint | null }) => tsOf.get(l.blockNumber!)!;
  const out: TradeRow[] = [];
  const byQuote = Map.groupBy(known, (t) => t.quote);
  for (const [quote, tokens] of byQuote) {
    const pools = new Set(tokens.map((t) => t.pool_id));
    const info = tokens[0];
    const q: Quote = { address: quote, decimals: info.quote_decimals, usd: 1 };
    const mine = <L extends { args: Record<string, unknown> }>(logs: L[], field: string) => logs.filter((l) => pools.has(String(l.args[field]).toLowerCase()));
    // deno-lint-ignore no-explicit-any
    const fees = hookFeesByTx(mine(hooks, "poolId") as any, tokenOfPool, q);
    const seen = new Map<string, number>();
    const swapRows = mine(swaps, "id").sort((x, y) => Number(x.blockNumber! - y.blockNumber!) || x.logIndex! - y.logIndex!).map((l) => {
      const pool = String(l.args.id).toLowerCase();
      const k = `${l.transactionHash}:${pool}`;
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      // deno-lint-ignore no-explicit-any
      return ascendSwapToRow(l as any, tokenOfPool.get(pool)!, q, txFrom.get(l.transactionHash!) ?? "", ts(l), fees.get(k)?.[n] ?? null);
    });
    // deno-lint-ignore no-explicit-any
    const usd = usdOf(info);
    // deno-lint-ignore no-explicit-any
    out.push(...withBidFills(swapRows, mine(fills, "poolId") as any, tokenOfPool, q, txFrom, ts as any).map((r) => rowInUsd(r, usd)));
  }
  await insertTrades(out, "tx_hash,log_index");
  return { launched: rows.length, trades: out.length };
}

/** Art for a few coins each run: new ones first, then ones still without an image (Ascend publishes after the launch). */
async function fetchAscendArt() {
  // The coins people see first: the top 50 by 24h volume still without art (unchecked, or last checked over 15 minutes ago)
  // go ahead of the rest. Without this, a backfill's hundreds of new coins kept the top 15's art waiting (2026-11-11).
  const recheck = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: top } = await db.from("ascend_token_stats").select("address").gt("volume_usd_24h", 0)
    .order("volume_usd_24h", { ascending: false }).limit(50);
  const { data: topDue } = top?.length
    ? await db.from("ascend_tokens").select("address").in("address", top.map((t: { address: string }) => t.address))
      .is("image_cid", null).or(`metadata_checked_at.is.null,metadata_checked_at.lt.${recheck}`)
    : { data: [] };
  const { data: due } = await db.from("ascend_tokens").select("address")
    .or(`metadata_checked_at.is.null,and(image_cid.is.null,metadata_checked_at.lt.${recheck}),metadata_checked_at.lt.${new Date(Date.now() - 24 * 3600_000).toISOString()}`)
    .order("metadata_checked_at", { ascending: true, nullsFirst: true }).limit(METADATA_PER_RUN);
  const queue = [...new Set([...(topDue ?? []), ...(due ?? [])].map((t: { address: string }) => t.address))].slice(0, METADATA_PER_RUN);
  let art = 0;
  for (const address of queue) {
    const res = await fetch(`https://api.ascendlaunch.xyz/v1/tokens/${address}/metadata`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (res?.status === 429) break; // back off until the next run
    const body = res?.ok ? await res.json().catch(() => null) : null;
    const update = { ...(body ? metadataColumns(body) : {}), metadata_checked_at: new Date().toISOString() };
    const { error } = await db.from("ascend_tokens").update(update).eq("address", address);
    if (error) throw new Error(`ascend metadata: ${error.message}`);
    if (body) art++;
  }
  return art;
}

/** An FTF that launched: copy its picture + category onto the token, then close its draft (matched by ticker; only one open
 *  draft per ticker). */
async function closeFtfDraft(address: string, symbol: string) {
  const { data: draft } = await db.from("ftf_drafts").select("pfp_url, category").eq("status", "open").eq("ticker", symbol).maybeSingle();
  if (draft) {
    const { error: tErr } = await db.from("tokens").update({ pfp_url: draft.pfp_url, category: draft.category }).eq("address", address);
    if (tErr) throw new Error(`ftf token: ${tErr.message}`);
  }
  const { error } = await db.from("ftf_drafts")
    .update({ status: "launched", token: address, updated_at: new Date().toISOString() })
    .eq("status", "open").eq("ticker", symbol);
  if (error) throw new Error(`ftf draft: ${error.message}`);
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

// Hyperliquid fills are only activity history, so every 10 minutes is plenty: each check asks Hyperliquid once per user (2026-10-22:
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
        (result.elysium as unknown[]).push(
          w.kind === "ascend_all" ? await indexAscendAll(w, usd) : w.kind === "ascend" ? await indexAscend(w) : await indexElysium(w, usd),
        );
      } catch (e) {
        (result.elysium as unknown[]).push({ registry: w.registry, error: failed(`elysium ${w.registry}`, e) });
      }
    }
  } catch (e) {
    result.elysiumError = failed("elysium", e);
  }
  // creator fees for our launches and Ascend's top tokens (creator_fees): the app reads them from there, not the chain
  try {
    const ascend = WORLDS.find((w) => w.kind === "ascend");
    result.creatorFees = await indexCreatorFees({
      chain,
      db,
      appRegistry: APP_REGISTRY,
      oursFrom: ascend?.fromBlock ?? 0n,
      hypeUsd: (result.hypeUsd as number | null) ?? null,
      getState,
      setState,
    });
  } catch (e) {
    result.creatorFees = failed("creator fees", e);
  }
  try {
    result.hyperliquid = await indexHyperliquid();
  } catch (e) {
    result.hyperliquidError = failed("hyperliquid", e);
  }
  if (seenHead > 0n) {
    await db.from("app_config").upsert({ key: "elysium_head", value: seenHead.toString(), updated_at: new Date().toISOString() });
  }
  const { data: linked, error } = await db.rpc("link_trades");
  result.tradesLinked = error ? failed("link_trades", error) : linked;
  await db.rpc("unlock_indexer");
  return json(200, result);
});
