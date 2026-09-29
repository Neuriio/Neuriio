// Live trades for charts: keeper/watcher.mjs broadcasts every curve/pool trade on the private Supabase Realtime
// channel "trades:<token>" as soon as its block appears (the indexer stores the same trade about a minute later).
// Receive-only for the app (migration 20260928020000_live_trades.sql). `?demo` (dev) fakes a trade every ~1.5 s.
import { RealtimeClient } from "@supabase/realtime-js";
import { SUPABASE_ANON_JWT, SUPABASE_URL } from "./config";
import { DEMO } from "./explore";

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
