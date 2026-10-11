// Candle chart for one launched token, on TradingView's Lightweight Charts (open source, Apache-2.0; its attribution
// logo stays on). Shows MARKET CAP in USD (HYPE price x 1B supply x HYPE/USD): launched-token prices are ~1e-6 USD,
// too small for readable axes, and mcap is what launchpad traders read. Users zoom/pan both axes: wheel or pinch zooms
// time, drag pans, dragging the price or time axis rescales it, double-clicking an axis resets it.
// Touch screens: a drag on the chart pans both ways (it holds the gesture instead of scrolling the page, and the
// price axis leaves auto-fit when grabbed, since the library only pans price when auto-fit is off); a double-tap resets.
//
// Two data sources, merged without glitches:
//   - stored candles (`candles` prop, from Supabase, refreshed by the parent): history, authoritative
//   - live trades (`applyTrade`, from the watcher over Realtime): move the current candle the moment a block lands
// Stored data lags live by up to a minute (indexer), so a bar that live trades touched is only replaced by its stored
// version once that version includes at least as many trades. New/changed bars are applied incrementally, keeping the
// user's zoom and scroll.
import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  PriceScaleMode,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/explore";
import type { LiveTrade } from "../lib/live";
import { compactUsd } from "../lib/format";

const SUPPLY = 1_000_000_000;
const UP = "#6ee7a0";
const DOWN = "#ff8a8a";
const VOL_UP = "rgba(110,231,160,0.35)";
const VOL_DOWN = "rgba(255,138,138,0.35)";

type Drawn = { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number; trades: number };

export type ChartControls = {
  reset: () => void;
  setLog: (on: boolean) => void;
  applyTrade: (t: LiveTrade) => void;
};

export function CandleChart({
  candles,
  interval,
  hypeUsd,
  basePriceHype,
  onControls,
}: {
  candles: Candle[] | null;
  interval: number; // seconds per candle
  hypeUsd: number; // frozen by the parent per token, so bars don't shift as HYPE's price moves
  basePriceHype: number; // price before any live trade (a brand-new token's first candle opens here)
  onControls?: (c: ChartControls) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const bars = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vols = useRef<ISeriesApi<"Histogram"> | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const drawn = useRef<Map<number, Drawn>>(new Map()); // what's on screen, by bar time
  const liveMin = useRef<Map<number, number>>(new Map()); // bar time -> trades a stored bar must have to replace it
  const touchFrozen = useRef(false); // a touch drag took the price axis off auto-fit
  const cfg = useRef({ interval, hypeUsd, basePriceHype });
  cfg.current = { interval, hypeUsd, basePriceHype };

  const draw = (d: Drawn, historical = false) => {
    drawn.current.set(d.time, d);
    bars.current!.update({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close }, historical);
    vols.current!.update({ time: d.time, value: d.volume, color: d.close >= d.open ? VOL_UP : VOL_DOWN }, historical);
  };

  // create once
  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8c7d9f",
        fontFamily: '"Lilex", ui-monospace, monospace',
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "rgba(236, 221, 255, 0.05)" },
        horzLines: { color: "rgba(236, 221, 255, 0.05)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(236, 221, 255, 0.12)", scaleMargins: { top: 0.1, bottom: 0.22 } },
      timeScale: { borderColor: "rgba(236, 221, 255, 0.12)", timeVisible: true, secondsVisible: false, rightOffset: 4 },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true, axisDoubleClickReset: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      localization: { priceFormatter: (v: number) => compactUsd(v) },
    });
    bars.current = c.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      priceFormat: { type: "custom", formatter: (v: number) => compactUsd(v), minMove: 0.01 },
    });
    vols.current = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    const reset = () => {
      c.priceScale("right").applyOptions({ autoScale: true });
      c.timeScale().resetTimeScale();
      c.timeScale().scrollToRealTime();
    };
    // touch: grabbing the chart freezes the price axis so it can pan up/down; a double-tap puts everything back
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
        reset();
        touchFrozen.current = false;
        lastTap = 0;
      } else lastTap = now;
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    onControls?.({
      reset,
      setLog: (on) => c.priceScale("right").applyOptions({ mode: on ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal }),
      applyTrade: (t) => {
        const { interval: s, hypeUsd: usd, basePriceHype: base } = cfg.current;
        if (!usd) return;
        // no spot price in the message (shouldn't happen since the watcher fix): use the trade's own average price
        const priceHype = t.priceHype ?? (t.tokens > 0 ? t.hype / t.tokens : null);
        if (priceHype == null) return;
        const mcap = priceHype * SUPPLY * usd;
        const time = (Math.floor(t.ts / 1000 / s) * s) as UTCTimestamp;
        if (drawn.current.size === 0) {
          // no stored candles yet (brand-new token): the first live trade draws the first candle
          const open = base * SUPPLY * usd;
          const first: Drawn = { time, open, high: Math.max(open, mcap), low: Math.min(open, mcap), close: mcap, volume: t.hype * usd, trades: 1 };
          liveMin.current.set(time, 1);
          draw(first);
          return;
        }
        const lastTime = Math.max(...drawn.current.keys());
        if (time < lastTime) return; // late for an older bar: the stored data will carry it
        const last = drawn.current.get(lastTime)!;
        const bar: Drawn =
          time === lastTime
            ? { ...last, high: Math.max(last.high, mcap), low: Math.min(last.low, mcap), close: mcap, volume: last.volume + t.hype * usd, trades: last.trades + 1 }
            : { time, open: last.close, high: Math.max(last.close, mcap), low: Math.min(last.close, mcap), close: mcap, volume: t.hype * usd, trades: 1 };
        liveMin.current.set(time, bar.trades);
        draw(bar);
      },
    });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
      c.remove();
      chart.current = null;
      drawn.current.clear();
      liveMin.current.clear();
    };
  }, [onControls]);

  // a new interval starts from scratch (and a touch-frozen price axis fits the new bars again)
  useEffect(() => {
    drawn.current.clear();
    liveMin.current.clear();
    if (touchFrozen.current) {
      chart.current?.priceScale("right").applyOptions({ autoScale: true });
      touchFrozen.current = false;
    }
  }, [interval]);

  // stored candles: full set the first time, then only new or changed bars
  useEffect(() => {
    const b = bars.current;
    const v = vols.current;
    if (!b || !v || !candles || !hypeUsd) return;
    const k = SUPPLY * hypeUsd;
    const next: Drawn[] = candles.map((c) => ({
      time: Math.floor(Date.parse(c.bucket) / 1000) as UTCTimestamp,
      open: c.open * k,
      high: c.high * k,
      low: c.low * k,
      close: c.close * k,
      volume: (c.volume_usd ?? c.volume_hype * hypeUsd) || 0,
      trades: c.trades,
    }));
    const map = drawn.current;
    if (next.length === 0 && map.size > 0) return; // nothing stored yet (new token): keep the live candles
    if (map.size === 0 || next.length === 0) {
      b.setData(next.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      v.setData(next.map((d) => ({ time: d.time, value: d.volume, color: d.close >= d.open ? VOL_UP : VOL_DOWN })));
      map.clear();
      for (const d of next) map.set(d.time, d);
      return;
    }
    const lastShown = Math.max(...map.keys());
    for (const d of next) {
      const need = liveMin.current.get(d.time);
      if (need !== undefined) {
        if (d.trades < need) continue; // stored version is behind the live one: keep live
        liveMin.current.delete(d.time);
      }
      const cur = map.get(d.time);
      if (cur && cur.open === d.open && cur.high === d.high && cur.low === d.low && cur.close === d.close && cur.volume === d.volume) continue;
      if (!cur && d.time < lastShown) continue; // outside what's drawn (older than the loaded window): skip
      draw(d, d.time < lastShown);
    }
  }, [candles, hypeUsd]);

  return <div ref={box} className="ex-lwc" />;
}
