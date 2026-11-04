// Trade Arena market data: Hyperliquid MAINNET perps (BTC, ETH), straight from Hyperliquid to the browser (no load on
// us; TRADE_ARENA.md phase 2). History from the info API (candleSnapshot), then live over one shared websocket: the
// open candle (candle) and the best bid/ask (bbo). Fills are NOT priced here: the trade engine fills from the
// watcher's stored bid/ask; this is only what the player sees.
import { useEffect, useState } from "react";
import { HttpTransport, InfoClient, SubscriptionClient, WebSocketTransport } from "@nktkas/hyperliquid";

export const PERP_MARKETS = ["BTC", "ETH"] as const;
export type PerpMarket = (typeof PERP_MARKETS)[number];

export const PERP_INTERVALS = [
  { label: "5m", hl: "5m", s: 300 },
  { label: "15m", hl: "15m", s: 900 },
  { label: "30m", hl: "30m", s: 1800 },
  { label: "1H", hl: "1h", s: 3600 },
  { label: "4H", hl: "4h", s: 14400 },
] as const;
export type PerpInterval = (typeof PERP_INTERVALS)[number]["hl"];

export type PerpCandle = { time: number; open: number; high: number; low: number; close: number; volume: number }; // time: s
export type Bbo = { bid: number; ask: number; mid: number; at: number }; // at: ms

const BARS = 300; // history per timeframe

const info = new InfoClient({ transport: new HttpTransport() }); // mainnet

// one websocket for the whole app, opened on first use (the SDK reconnects and re-subscribes by itself)
let subs: SubscriptionClient | null = null;
const ws = () => (subs ??= new SubscriptionClient({ transport: new WebSocketTransport() }));

const toCandle = (c: { t: number; o: string; h: string; l: string; c: string; v: string }): PerpCandle => ({
  time: Math.floor(c.t / 1000),
  open: +c.o,
  high: +c.h,
  low: +c.l,
  close: +c.c,
  volume: +c.v,
});

/** The last BARS candles of `coin` at `interval`. */
export async function perpCandles(coin: PerpMarket, interval: PerpInterval): Promise<PerpCandle[]> {
  const s = PERP_INTERVALS.find((x) => x.hl === interval)!.s;
  const rows = await info.candleSnapshot({ coin, interval, startTime: Date.now() - BARS * s * 1000 });
  return rows.map(toCandle);
}

/** Calls `onBar` with every update of the open candle (and the first tick of each new one). Returns unsubscribe. */
export function watchPerpCandle(coin: PerpMarket, interval: PerpInterval, onBar: (c: PerpCandle) => void): () => void {
  let stop: (() => void) | null = null;
  let dead = false;
  ws()
    .candle({ coin, interval }, (c) => onBar(toCandle(c)))
    .then((sub) => {
      if (dead) void sub.unsubscribe();
      else stop = () => void sub.unsubscribe();
    })
    .catch(() => {}); // the chart keeps its history; a reconnect re-subscribes
  return () => {
    dead = true;
    stop?.();
  };
}

/** Live best bid / ask / mid of `coin`; null until the first update. */
export function useBbo(coin: PerpMarket): Bbo | null {
  const [bbo, setBbo] = useState<Bbo | null>(null);
  useEffect(() => {
    setBbo(null);
    let stop: (() => void) | null = null;
    let dead = false;
    ws()
      .bbo({ coin }, (e) => {
        const [b, a] = e.bbo;
        if (!b || !a) return;
        const bid = +b.px;
        const ask = +a.px;
        setBbo({ bid, ask, mid: (bid + ask) / 2, at: e.time });
      })
      .then((sub) => {
        if (dead) void sub.unsubscribe();
        else stop = () => void sub.unsubscribe();
      })
      .catch(() => {});
    return () => {
      dead = true;
      stop?.();
    };
  }, [coin]);
  return bbo;
}

/** Live best bid/ask for every arena market (BTC and ETH), for PnL across open positions. */
export function useAllBbo(): Record<PerpMarket, Bbo | null> {
  const btc = useBbo("BTC");
  const eth = useBbo("ETH");
  return { BTC: btc, ETH: eth };
}
