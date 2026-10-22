// Live trades for charts: keeper/watcher.mjs broadcasts every curve/pool trade on the private Supabase Realtime
// channel "trades:<token>" as soon as its block appears (the indexer stores the same trade about a minute later), and
// all of them on "trades:all" in one message per second. Receive-only for the app (migration
// 20260928020000_live_trades.sql). A tab hidden for a minute closes its live channels until it's shown again.
// `?demo` (dev) fakes a trade every ~1.5 s.
import { useSyncExternalStore } from "react";
import { RealtimeClient } from "@supabase/realtime-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";
import { DEMO, LANDING, topByTotalVolume } from "./explore";

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

/** keeper watcher "graduated" event: a buy just graduated `token` (its pool is open, LP burned). */
export type LiveGraduation = { token: string; pair: string; trader: string | null; tx: string; ts: number };

let client: RealtimeClient | null = null;
function rt() {
  if (!client) {
    // the publishable key joins as `anon`, which may receive on the private trades channels (legacy JWT keys are off)
    client = new RealtimeClient(`${SUPABASE_URL}/realtime/v1`, { params: { apikey: SUPABASE_PUBLISHABLE_KEY } });
  }
  return client;
}

// ------------------------------------------------------------------ hidden tabs
// Supabase bills peak connections and every message delivered, and a background tab needs neither: after a minute
// hidden, every live subscription closes along with the connection; showing the tab again opens them on a fresh
// connection and calls each one's onResume, so its view can catch up on what it missed.

type Live = { open: () => () => void; close: (() => void) | null; onResume?: () => void };
const lives = new Set<Live>();
const HIDDEN_GRACE_MS = 60_000; // a quick trip to another tab keeps everything open
let paused = false;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

/** Opens a live subscription now (or when the tab is shown again); returns its unsubscribe. */
function keepLive(open: () => () => void, onResume?: () => void): () => void {
  const l: Live = { open, close: paused ? null : open(), onResume };
  lives.add(l);
  return () => {
    lives.delete(l);
    l.close?.();
    l.close = null;
  };
}

function pause() {
  hideTimer = null;
  paused = true;
  for (const l of lives) {
    l.close?.();
    l.close = null;
  }
  const old = client;
  client = null; // reopening uses a new connection, so no half-closed channel is reused
  void old?.disconnect();
}

function resume() {
  paused = false;
  for (const l of lives) {
    l.close = l.open();
    l.onResume?.();
  }
}

// dev builds only: lets a test read the live state (paused, open subscriptions, connection)
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __live: () => unknown }).__live = () => ({
    paused,
    subscriptions: lives.size,
    open: [...lives].filter((l) => l.close).length,
    connected: client?.isConnected() ?? false,
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hideTimer ??= setTimeout(pause, HIDDEN_GRACE_MS);
      return;
    }
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (paused) resume();
  });
}

/** Calls `onTrade` for each live trade of `token` (and `onGraduated` if it graduates); returns an unsubscribe.
 *  `onResume`: the tab was hidden long enough to close the feed and is back (trades in between were missed). */
export function subscribeTrades(
  token: string,
  onTrade: (t: LiveTrade) => void,
  startPriceHype?: number,
  onGraduated?: (g: LiveGraduation) => void,
  onResume?: () => void,
): () => void {
  if (LANDING) return () => {}; // the landing's showcase chart stays still
  if (DEMO) return keepLive(() => demoFeed(token, onTrade, startPriceHype ?? 1e-7));
  const seen = new Set<string>();
  return keepLive(() => {
    const channel = rt().channel(`trades:${token.toLowerCase()}`, { config: { private: true } });
    channel
      .on("broadcast", { event: "trade" }, ({ payload }) => {
        const t = payload as LiveTrade;
        const id = `${t.tx}:${t.logIndex}`;
        if (seen.has(id)) return; // the watcher's websocket + polling paths never double-send, but be safe
        seen.add(id);
        onTrade(t);
      })
      .on("broadcast", { event: "graduated" }, ({ payload }) => onGraduated?.(payload as LiveGraduation))
      .subscribe();
    return () => {
      rt().removeChannel(channel);
    };
  }, onResume);
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
// Every trade of every launched token, about a second after its block lands (the watcher sends them in one message
// per second): live prices for lists (Top 25, positions) and the viewer's own trades before the indexer stores them.
// One subscription shared by the whole page.

export const tradeId = (t: { tx: string; logIndex: number }) => `${t.tx.toLowerCase()}:${t.logIndex}`;

type Feed = { prices: Record<string, number>; recent: LiveTrade[] }; // prices: token -> HYPE per token (latest)
let feed: Feed = { prices: {}, recent: [] };
const listeners = new Set<() => void>();
let stopAll: (() => void) | null = null;
const seenAll = new Set<string>();

function onTrades(trades: LiveTrade[]) {
  const fresh = trades.filter((t) => {
    const id = tradeId(t);
    if (seenAll.has(id)) return false;
    seenAll.add(id);
    return true;
  });
  if (!fresh.length) return;
  if (seenAll.size > 20_000) seenAll.clear();
  const prices = { ...feed.prices };
  for (const t of fresh) if (t.priceHype != null) prices[t.token.toLowerCase()] = t.priceHype;
  feed = { prices, recent: [...feed.recent, ...fresh].slice(-500) };
  listeners.forEach((l) => l());
}

function startAll() {
  if (LANDING) {
    stopAll = () => {}; // showcase prices stay as set
    return;
  }
  if (DEMO) {
    stopAll = keepLive(() => demoAllFeed((t) => onTrades([t])));
    return;
  }
  stopAll = keepLive(
    () => {
      const channel = rt().channel("trades:all", { config: { private: true } });
      channel
        .on("broadcast", { event: "trades" }, ({ payload }) => onTrades((payload as { trades?: LiveTrade[] }).trades ?? []))
        .on("broadcast", { event: "trade" }, ({ payload }) => onTrades([payload as LiveTrade])) // watcher before 2026-10-22
        .subscribe();
      return () => {
        rt().removeChannel(channel);
      };
    },
    () => {
      // prices seen before the pause are stale: show the stored ones until new trades arrive
      feed = { prices: {}, recent: feed.recent };
      listeners.forEach((l) => l());
    },
  );
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
