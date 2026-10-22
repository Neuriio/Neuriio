// Live trade watcher: follows Elysium block by block and broadcasts every launched-token trade (bonding curve and
// graduated pools) from EVERY Launchpad version in the LaunchRegistry (re-read each minute, so a new version is
// picked up without a restart) and every router in the deployments file on Supabase Realtime the moment its block appears, so charts update without waiting for the
// once-a-minute indexer. Stateless: storing trades stays the indexer's job (supabase/functions/indexer).
//
//   Primary: websocket log subscription (WS_URL; Elysium's official RPC has no websocket, the hypedexer node does).
//   Fallback: HTTP polling of eth_getLogs every POLL_MS (RPC_URL) whenever the websocket is down.
//   Output:   private Realtime channels "trades:<token>" and "trades:all", event "trade" (see src/watch/trades.mjs),
//             plus event "graduated" {token, pair, trader, tx, ts} when a buy graduates a token (the app's overlay).
//             Only the service key can send there (migration 20260928020000_live_trades.sql). Sent over a
//             persistent Realtime websocket (~75-135 ms to a viewer, measured 2026-09-29) instead of the REST
//             broadcast endpoint (~300-490 ms); REST only while a token's channel is still joining.
//
// env: SUPABASE_URL, SUPABASE_SERVICE_KEY (the project's secret key, sb_secret_...; run-watcher.sh fetches it via the CLI),
//      WS_URL, RPC_URL ("primary,fallback"), POLL_MS (default 500), DEPLOYMENTS (default ../deployments/elysium-testnet.json)
import { readFileSync } from "node:fs";
import { RealtimeClient } from "@supabase/realtime-js";
import { createPublicClient, parseAbi, parseEventLogs, webSocket } from "viem";
import { makeTransport } from "./src/rpc.mjs";
import { liveTrades, priceOf, watchEvents } from "./src/watch/trades.mjs";

const env = (k, d) => process.env[k] ?? d;
const dep = JSON.parse(readFileSync(new URL(env("DEPLOYMENTS", "../deployments/elysium-testnet.json"), import.meta.url)));
const SUPABASE_URL = env("SUPABASE_URL", "https://yviymgfgaepmtijgyyyo.supabase.co");
const SERVICE_KEY = env("SUPABASE_SERVICE_KEY");
if (!SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY is required (use ./script/run-watcher.sh)");
const WS_URL = env("WS_URL", "wss://elysium-testnet-rpc.hypedexer.com/");
const RPC_URL = env("RPC_URL", "https://testnet-rpc.elysium.kinetiq.xyz,https://elysium-testnet-rpc.hypedexer.com/");
const POLL_MS = Number(env("POLL_MS", 500));

const lc = (a) => a.toLowerCase();
const ctx = {
  launchpads: new Set(), // every Launchpad version (LaunchRegistry.launchpads), loaded below
  routers: new Set((dep.routers ?? [dep.swapRouter]).map(lc)),
  quote: lc(dep.usdc ?? dep.whype), // the world's quote token: USDC (the old world: WHYPE)
  decimals: 18, // read from the quote token below
  pairToken: new Map(), // pair -> token, filled from the factory, then from Graduated events
};
const log = (ev, o = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...o }));

const http = createPublicClient({ transport: makeTransport(RPC_URL, { name: "watcher" }) });

// ------------------------------------------------------------------ pairs

const factoryAbi = parseAbi([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
]);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

async function loadPairs() {
  const n = Number(await http.readContract({ address: dep.swapFactory, abi: factoryAbi, functionName: "allPairsLength" }));
  for (let i = 0; i < n; i++) {
    const pair = lc(await http.readContract({ address: dep.swapFactory, abi: factoryAbi, functionName: "allPairs", args: [BigInt(i)] }));
    const [t0, t1] = await Promise.all(["token0", "token1"].map((f) => http.readContract({ address: pair, abi: pairAbi, functionName: f })));
    ctx.pairToken.set(pair, lc(lc(t0) === ctx.quote ? t1 : t0));
  }
}
const registryAbi = parseAbi([
  "function launchpadsLength() view returns (uint256)",
  "function launchpads(uint256) view returns (address)",
  "function allTokensLength() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
]);
/** Every Launchpad version ever approved; true if the list changed. */
async function loadLaunchpads() {
  const n = Number(await http.readContract({ address: dep.launchRegistry, abi: registryAbi, functionName: "launchpadsLength" }));
  let changed = false;
  for (let i = 0; i < n; i++) {
    const p = lc(await http.readContract({ address: dep.launchRegistry, abi: registryAbi, functionName: "launchpads", args: [BigInt(i)] }));
    if (!ctx.launchpads.has(p)) (ctx.launchpads.add(p), (changed = true));
  }
  return changed;
}
const addresses = () => [...ctx.launchpads, ...ctx.routers, ...ctx.pairToken.keys()];

// ------------------------------------------------------------------ broadcast

// One persistent Realtime connection; a joined private channel per active topic (LRU, left after 10 quiet minutes).
const realtime = new RealtimeClient(`${SUPABASE_URL}/realtime/v1`, { params: { apikey: SERVICE_KEY } });
const channels = new Map(); // topic -> { ch, ready, lastUsed }
const MAX_CHANNELS = 80;
const IDLE_MS = 10 * 60_000;

function channelFor(topic) {
  let c = channels.get(topic);
  if (!c) {
    if (channels.size >= MAX_CHANNELS) {
      const [oldest] = [...channels].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      realtime.removeChannel(channels.get(oldest).ch);
      channels.delete(oldest);
    }
    const ch = realtime.channel(topic, { config: { private: true, broadcast: { ack: false } } });
    c = { ch, ready: false, lastUsed: Date.now() };
    channels.set(topic, c);
    ch.subscribe((status, err) => {
      c.ready = status === "SUBSCRIBED";
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") log("realtime_channel", { topic, status, error: err?.message });
    });
  }
  c.lastUsed = Date.now();
  return c;
}
setInterval(() => {
  for (const [topic, c] of channels) {
    if (topic !== "trades:all" && Date.now() - c.lastUsed > IDLE_MS) {
      realtime.removeChannel(c.ch);
      channels.delete(topic);
    }
  }
}, 60_000).unref();
channelFor("trades:all"); // always joined

async function broadcast(items, event = "trade") {
  if (!items.length) return;
  const viaRest = [];
  for (const t of items) {
    for (const topic of [`trades:${t.token}`, "trades:all"]) {
      const c = channelFor(topic);
      if (c.ready) c.ch.send({ type: "broadcast", event, payload: t }).catch(() => {});
      else viaRest.push({ topic, event, payload: t, private: true }); // channel still joining
    }
  }
  if (!viaRest.length) return;
  const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: viaRest }),
  });
  if (!res.ok) log("broadcast_error", { status: res.status, body: (await res.text()).slice(0, 200) });
}

// ------------------------------------------------------------------ handling a batch of logs

const seen = new Set(); // tx:logIndex, so a block seen by both paths is sent once
const blockTs = new Map();
let polled = 0n; // the polling path's cursor (independent of the websocket; `seen` dedupes the overlap)

// Block time without an extra RPC round trip (that cost ~1 s per block): use the log's own blockTimestamp when the
// node includes it, else the time we received the block (Elysium's clock trails real time by ~1-2 s anyway, and the
// stored candles from the indexer use the exact block time).
function timestampOf(group) {
  const bt = group.find((l) => l.blockTimestamp != null)?.blockTimestamp;
  if (bt != null) {
    const ms = Number(typeof bt === "string" ? BigInt(bt) : bt) * 1000;
    if (ms > 0) return ms;
  }
  if (!blockTs.has(group[0].blockNumber)) {
    blockTs.set(group[0].blockNumber, Date.now());
    if (blockTs.size > 500) blockTs.delete(blockTs.keys().next().value);
  }
  return blockTs.get(group[0].blockNumber);
}

async function handle(logs, source) {
  const fresh = logs.filter((l) => !seen.has(`${l.transactionHash}:${l.logIndex}`));
  if (!fresh.length) return;
  for (const l of fresh) seen.add(`${l.transactionHash}:${l.logIndex}`);
  if (seen.size > 20_000) seen.clear();
  const byBlock = Map.groupBy(fresh, (l) => l.blockNumber);
  for (const [n, group] of [...byBlock].sort((a, b) => Number(a[0] - b[0]))) {
    const received = Date.now();
    const ts = timestampOf(group);
    const { trades: raw, graduated } = liveTrades(group, ctx, ts);
    const trades = await completePoolTrades(raw, ts);
    await priceMissing(trades, n);
    await broadcast(trades);
    await broadcast(graduated, "graduated"); // after its trades, so charts already show the last curve buy
    if (trades.length) log("trades", { block: Number(n), n: trades.length, source, ms: Date.now() - received });
    for (const g of graduated) {
      ctx.pairToken.set(g.pair, g.token);
      log("graduated", g);
      resubscribe(); // watch the new pool too
    }
  }
}

// A pool trade needs three logs of its tx: the pair's Sync (price), Swap (amounts) and our router's Swapped (trader, and
// the id the indexer stores it under). The websocket can split one tx's logs across batches; then the trade went out
// with no price and/or no trader, so charts skipped it and Positions (which match the trader) missed it until the
// stored data caught up, and its id didn't match the stored copy (found 2026-10-10). Rebuild such trades from the tx
// receipt, which has every log (one RPC read, ~0.2 s). Aggregator trades legitimately have no router log: they stay
// trader-less after the rebuild.
async function completePoolTrades(trades, ts) {
  const partial = new Set(trades.filter((t) => t.venue === "pool" && (t.priceHype == null || t.trader == null)).map((t) => t.tx));
  if (!partial.size) return trades;
  const rebuilt = new Map();
  await Promise.all(
    [...partial].map(async (hash) => {
      try {
        const receipt = await http.getTransactionReceipt({ hash });
        const logs = parseEventLogs({ abi: watchEvents, logs: receipt.logs, strict: false }).filter((l) => l.eventName);
        for (const l of logs) seen.add(`${l.transactionHash}:${l.logIndex}`); // its other logs arriving later stay quiet
        rebuilt.set(hash, liveTrades(logs, ctx, ts).trades.filter((t) => t.venue === "pool"));
      } catch (e) {
        log("receipt_error", { tx: hash, error: e.shortMessage ?? e.message });
      }
    }),
  );
  return trades.flatMap((t) => (t.venue === "pool" && rebuilt.has(t.tx) ? [] : [t])).concat([...rebuilt.values()].flat());
}

// Last resort if a pool trade still has no price: read the pair's reserves at that block.
// A pool trade's price comes from the pair's Sync in the same tx, but the websocket can deliver the Sync and the Swap
// in separate batches; then the trade has no price and the charts skipped it (found 2026-10-10). Fill it from the
// pair's reserves at that block (one RPC read, ~0.2 s).
async function priceMissing(trades, blockNumber) {
  for (const t of trades) {
    if (t.venue !== "pool" || t.priceHype != null) continue;
    const pair = [...ctx.pairToken].find(([, tok]) => tok === t.token)?.[0];
    if (!pair) continue;
    try {
      const [[r0, r1], t0] = await Promise.all([
        http.readContract({ address: pair, abi: pairAbi, functionName: "getReserves", blockNumber }),
        http.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
      ]);
      const [quote, tok] = lc(t0) === ctx.quote ? [r0, r1] : [r1, r0];
      t.priceHype = priceOf(quote, tok, ctx.decimals);
    } catch (e) {
      log("price_error", { token: t.token, error: e.shortMessage ?? e.message });
    }
  }
}

// ------------------------------------------------------------------ websocket (primary)

let unwatch = null;
let wsHealthy = false;
let ws = null;

function subscribe() {
  ws ??= createPublicClient({ transport: webSocket(WS_URL, { keepAlive: { interval: 15_000 }, reconnect: { attempts: Infinity, delay: 2_000 } }) });
  unwatch = ws.watchEvent({
    address: addresses(),
    events: watchEvents,
    onLogs: (logs) => {
      wsHealthy = true;
      handle(logs, "ws").catch((e) => log("handle_error", { error: e.message }));
    },
    onError: (e) => {
      if (wsHealthy) log("ws_down", { error: e.shortMessage ?? e.message });
      wsHealthy = false;
    },
  });
  wsHealthy = true;
}
function resubscribe() {
  unwatch?.();
  subscribe();
}

// ------------------------------------------------------------------ polling (fallback + gap filler)

// Polls quickly while the websocket is down, and slowly otherwise to fill any block the subscription missed.
async function poll() {
  try {
    const head = await http.getBlockNumber({ cacheTime: 0 });
    if (polled === 0n) polled = head;
    const quiet = wsHealthy ? 2n : 0n; // leave the newest blocks to the websocket when it's up
    if (head - quiet > polled) {
      const to = head - quiet > polled + 500n ? polled + 500n : head - quiet;
      const logs = await http.getLogs({ address: addresses(), events: watchEvents, fromBlock: polled + 1n, toBlock: to });
      await handle(logs, "poll");
      polled = to;
    }
  } catch (e) {
    log("poll_error", { error: e.shortMessage ?? e.message });
  }
  setTimeout(poll, wsHealthy ? POLL_MS * 6 : POLL_MS);
}

// ------------------------------------------------------------------ start

ctx.decimals = Number(await http.readContract({ address: ctx.quote, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" }));
await loadLaunchpads();
await loadPairs();
// join the newest tokens' channels now, so their next trade already goes out over the websocket
const reg = dep.launchRegistry;
const nTokens = Number(await http.readContract({ address: reg, abi: registryAbi, functionName: "allTokensLength" }));
for (let i = nTokens - 1; i >= Math.max(0, nTokens - (MAX_CHANNELS - 1)); i--) {
  channelFor(`trades:${lc(await http.readContract({ address: reg, abi: registryAbi, functionName: "allTokens", args: [BigInt(i)] }))}`);
}
log("start", { registry: reg, quote: ctx.quote, decimals: ctx.decimals, launchpads: [...ctx.launchpads], routers: [...ctx.routers], pairs: ctx.pairToken.size, tokens: nTokens, ws: WS_URL });
subscribe();
poll();
// a new Launchpad version approved in the registry: start watching it too (no restart needed)
setInterval(() => {
  loadLaunchpads()
    .then((changed) => changed && (log("launchpads", { launchpads: [...ctx.launchpads] }), resubscribe()))
    .catch((e) => log("launchpads_error", { error: e.shortMessage ?? e.message }));
}, 60_000).unref();
