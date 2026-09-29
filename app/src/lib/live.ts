// Live trades for charts: keeper/watcher.mjs broadcasts every curve/pool trade on the private Supabase Realtime
// channel "trades:<token>" as soon as its block appears (the indexer stores the same trade about a minute later).
// Receive-only for the app (migration 20260928020000_live_trades.sql). `?demo` (dev) fakes a trade every ~1.5 s.
import { useSyncExternalStore } from "react";
import { RealtimeClient } from "@supabase/realtime-js";
import { SUPABASE_ANON_JWT, SUPABASE_URL } from "./config";
import { DEMO, topByTotalVolume } from "./explore";

/** keeper/src/watch/trades.mjs LiveTrade */
export type LiveTrade = {
  token: string;
  venue: "curve" | "pool";
  side: "buy" | "sell";
  trader: string | null;
  hype: number;
  tokens: number;
  priceHype: number | null; // spot price after the trade
  tx: string;
  logIndex: number;
  block: number;
  ts: number; // block time, ms
};

let client: RealtimeClient | null = null;
function rt() {
  if (!client) {
    client = new RealtimeClient(`${SUPABASE_URL}/realtime/v1`, { params: { apikey: SUPABASE_ANON_JWT } });
    client.setAuth(SUPABASE_ANON_JWT);
  }
  return client;
}

/** Calls `onTrade` for each live trade of `token`; returns an unsubscribe function. */
export function subscribeTrades(token: string, onTrade: (t: LiveTrade) => void, startPriceHype?: number): () => void {
  if (DEMO) return demoFeed(token, onTrade, startPriceHype ?? 1e-7);
  const seen = new Set<string>();
  const channel = rt().channel(`trades:${token.toLowerCase()}`, { config: { private: true } });
  channel
    .on("broadcast", { event: "trade" }, ({ payload }) => {
      const t = payload as LiveTrade;
      const id = `${t.tx}:${t.logIndex}`;
      if (seen.has(id)) return; // the watcher's websocket + polling paths never double-send, but be safe
      seen.add(id);
      onTrade(t);
    })
    .subscribe();
  return () => {
    rt().removeChannel(channel);
  };
}

function demoFeed(token: string, onTrade: (t: LiveTrade) => void, start: number) {
  let price = start;
  let n = 0;
  const id = setInterval(() => {
    const buy = Math.random() < 0.55;
    price *= 1 + (buy ? 1 : -1) * Math.random() * 0.012;
    const hype = +(0.002 + Math.random() * 0.02).toFixed(4); // small, like the demo history's volumes
    onTrade({
      token,
      venue: "curve",
      side: buy ? "buy" : "sell",
      trader: null,
      hype,
      tokens: hype / price,
      priceHype: price,
      tx: `demo-${token}-${n}`,
      logIndex: n++,
      block: 0,
      ts: Date.now(),
    });
  }, 900 + Math.random() * 1200);
  return () => clearInterval(id);
}

// ------------------------------------------------------------------ page-wide feed ("trades:all")
// Every trade of every launched token, as its block lands: live prices for lists (Top 25, positions) and the
// viewer's own trades before the indexer stores them. One subscription shared by the whole page.

export const tradeId = (t: { tx: string; logIndex: number }) => `${t.tx.toLowerCase()}:${t.logIndex}`;

type Feed = { prices: Record<string, number>; recent: LiveTrade[] }; // prices: token -> HYPE per token (latest)
let feed: Feed = { prices: {}, recent: [] };
const listeners = new Set<() => void>();
let stopAll: (() => void) | null = null;
const seenAll = new Set<string>();

function onAnyTrade(t: LiveTrade) {
  const id = tradeId(t);
  if (seenAll.has(id)) return;
  seenAll.add(id);
  feed = {
    prices: t.priceHype != null ? { ...feed.prices, [t.token.toLowerCase()]: t.priceHype } : feed.prices,
    recent: [...feed.recent.slice(-499), t],
  };
  listeners.forEach((l) => l());
}

function startAll() {
  if (DEMO) {
    stopAll = demoAllFeed(onAnyTrade);
    return;
  }
  const channel = rt().channel("trades:all", { config: { private: true } });
  channel.on("broadcast", { event: "trade" }, ({ payload }) => onAnyTrade(payload as LiveTrade)).subscribe();
  stopAll = () => {
    rt().removeChannel(channel);
  };
}

function subscribeFeed(l: () => void) {
  listeners.add(l);
  if (!stopAll) startAll();
  return () => {
    listeners.delete(l);
    if (!listeners.size && stopAll) {
      stopAll();
      stopAll = null;
    }
  };
}

/** Latest live price (HYPE per token) of every token that traded since the page opened. */
export function useLivePrices(): Record<string, number> {
  return useSyncExternalStore(subscribeFeed, () => feed.prices);
}

/** Trades seen live since the page opened (newest last, up to 500). */
export function useLiveTrades(): LiveTrade[] {
  return useSyncExternalStore(subscribeFeed, () => feed.recent);
}

/** ?demo: random trades across the sample Top 25, so live list prices can be seen moving. */
function demoAllFeed(onTrade: (t: LiveTrade) => void) {
  let tokens: { address: string; price: number }[] = [];
  topByTotalVolume().then(({ tokens: ts }) => (tokens = ts.map((t) => ({ address: t.address, price: t.price_hype }))));
  let n = 0;
  const id = setInterval(() => {
    if (!tokens.length) return;
    const k = tokens[Math.floor(Math.random() * tokens.length)];
    const buy = Math.random() < 0.55;
    k.price *= 1 + (buy ? 1 : -1) * Math.random() * 0.02;
    const hype = +(0.002 + Math.random() * 0.02).toFixed(4);
    onTrade({
      token: k.address, venue: "curve", side: buy ? "buy" : "sell", trader: null, hype, tokens: hype / k.price,
      priceHype: k.price, tx: `demo-all-${n}`, logIndex: n++, block: 0, ts: Date.now(),
    });
  }, 700);
  return () => clearInterval(id);
}
