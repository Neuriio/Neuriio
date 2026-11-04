// Trade Arena chart: a Hyperliquid perp (BTC or ETH, mainnet prices) as candles + volume on TradingView's Lightweight
// Charts, like Explore's CandleChart (same look, colors, zoom/pan and touch behaviour), with the timeframe buttons
// 5m 15m 30m 1H 4H. History comes from Hyperliquid's info API, then the open candle moves live over the websocket
// (lib/perps.ts). Prices are USD per coin.
import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  PERP_INTERVALS,
  perpCandles,
  watchPerpCandle,
  type PerpCandle,
  type PerpInterval,
  type PerpMarket,
} from "../lib/perps";

const UP = "#316f59";
const DOWN = "#ff8a8a";
const VOL_UP = "rgba(49,111,89,0.6)";
const VOL_DOWN = "rgba(255,138,138,0.35)";
const DECIMALS: Record<PerpMarket, number> = { BTC: 0, ETH: 2 };

export function PerpChart({ market }: { market: PerpMarket }) {
  const [interval, setInterval_] = useState<PerpInterval>("5m");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const bars = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vols = useRef<ISeriesApi<"Histogram"> | null>(null);
  const touchFrozen = useRef(false);

  // create once
  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8c7d9f",
        fontFamily: '"Manrope", ui-sans-serif, system-ui, sans-serif',
        fontSize: 11,
        attributionLogo: false, // credited as "Charts by TradingView" under the chart
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(236, 221, 255, 0.12)", scaleMargins: { top: 0.1, bottom: 0.22 } },
      timeScale: { borderColor: "rgba(236, 221, 255, 0.12)", timeVisible: true, secondsVisible: false, rightOffset: 4 },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        mouseWheel: true,
        pinch: true,
        axisDoubleClickReset: true,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    });
    bars.current = c.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
    });
    vols.current = c.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    // touch: grabbing the chart frees the price axis so it can pan up/down; a double-tap puts everything back
    const el = box.current!;
    let lastTap = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      c.priceScale("right").applyOptions({ autoScale: false });
      touchFrozen.current = true;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) return;
      const now = performance.now();
      if (now - lastTap < 300) {
        c.priceScale("right").applyOptions({ autoScale: true });
        c.timeScale().resetTimeScale();
        c.timeScale().scrollToRealTime();
        touchFrozen.current = false;
        lastTap = 0;
      } else lastTap = now;
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
      c.remove();
      chart.current = bars.current = vols.current = null;
    };
  }, []);

  // price format follows the market
  useEffect(() => {
    const d = DECIMALS[market];
    bars.current?.applyOptions({ priceFormat: { type: "price", precision: d, minMove: 1 / 10 ** d } });
  }, [market]);

  // history, then live: a new market or timeframe starts from scratch
  useEffect(() => {
    let alive = true;
    const b = bars.current!;
    const v = vols.current!;
    const put = (c: PerpCandle) => {
      b.update({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });
      v.update({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? VOL_UP : VOL_DOWN });
    };
    setState("loading");
    b.setData([]);
    v.setData([]);
    if (touchFrozen.current) {
      chart.current?.priceScale("right").applyOptions({ autoScale: true });
      touchFrozen.current = false;
    }
    let last = 0; // newest bar time drawn: older live ticks are ignored
    const pending: PerpCandle[] = []; // live ticks that arrive before the history
    let loaded = false;
    const stop = watchPerpCandle(market, interval, (c) => {
      if (!alive) return;
      if (!loaded) return void pending.push(c);
      if (c.time < last) return;
      last = c.time;
      put(c);
    });
    perpCandles(market, interval)
      .then((rows) => {
        if (!alive) return;
        b.setData(
          rows.map(({ time, open, high, low, close }) => ({ time: time as UTCTimestamp, open, high, low, close })),
        );
        v.setData(
          rows.map((c) => ({
            time: c.time as UTCTimestamp,
            value: c.volume,
            color: c.close >= c.open ? VOL_UP : VOL_DOWN,
          })),
        );
        last = rows.at(-1)?.time ?? 0;
        loaded = true;
        for (const c of pending) if (c.time >= last) ((last = c.time), put(c));
        chart.current?.timeScale().scrollToRealTime();
        setState("ready");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
      stop();
    };
  }, [market, interval]);

  return (
    <div className="pc">
      <div className="ex-chart-bar pc-bar">
        {PERP_INTERVALS.map((x) => (
          <button
            key={x.hl}
            className={`ex-range${x.hl === interval ? " is-on" : ""}`}
            onClick={() => setInterval_(x.hl)}
          >
            {x.label}
          </button>
        ))}
        {state === "loading" && <span className="pc-note">Loading…</span>}
        {state === "error" && <span className="pc-note">Couldn't load the chart from Hyperliquid</span>}
      </div>
      <div ref={box} className="pc-chart" />
      <a className="pc-credit" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
        Charts by TradingView
      </a>
    </div>
  );
}
