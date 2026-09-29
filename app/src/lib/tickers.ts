// Top-of-page ticker marquee: live HyperCore (mainnet) prices, polled every 5 s, green/red vs 24h ago.
// API weight per viewer (HL limit 1,200/min per IP): allMids = 2 every 5 s (~24/min) +
// metaAndAssetCtxs (weight 20, carries prevDayPx) every 10 min (~2/min).
// Picks (2026-09-26, by 24h perp volume): top 10 main-dex crypto perps, except PUMP (its icon is a
// traced picture with no clean mark to make white) -> next one, SUI. Icons are all white, in
// public/tickers/white/: Simple Icons glyphs (BTC ETH SOL ZEC NEAR XRP SUI), Hyperliquid's own HYPE
// and XPL shapes, and the ENA mark taken out of Hyperliquid's ENA icon (background removed).
import { useEffect, useState } from "react";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { Logo } from "../components/LogoMarquee";

type Ticker = { label: string; coin: string; dex: string };

export const TICKERS: Ticker[] = [
  { label: "BTC", coin: "BTC", dex: "" },
  { label: "ETH", coin: "ETH", dex: "" },
  { label: "SOL", coin: "SOL", dex: "" },
  { label: "ZEC", coin: "ZEC", dex: "" },
  { label: "HYPE", coin: "HYPE", dex: "" },
  { label: "NEAR", coin: "NEAR", dex: "" },
  { label: "XRP", coin: "XRP", dex: "" },
  { label: "ENA", coin: "ENA", dex: "" },
  { label: "XPL", coin: "XPL", dex: "" },
  { label: "SUI", coin: "SUI", dex: "" },
];

const info = new InfoClient({ transport: new HttpTransport() }); // mainnet prices
const DEXES = [...new Set(TICKERS.map((t) => t.dex))];

/** $83,874 · $2,685.30 · $91.56 · $0.2668 */
export function formatPrice(n: number) {
  const dp = n >= 10_000 ? 0 : n >= 1 ? 2 : 4;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

const PREV_DAY_EVERY_MS = 10 * 60_000;

/** Marquee items with live prices + day direction. Keeps the last good values on errors. */
export function useTickerLogos(everyMs = 5_000): Logo[] {
  const [mids, setMids] = useState<Record<string, string>>({});
  const [prevDay, setPrevDay] = useState<Record<string, number>>({});

  // price 24h ago, per coin (HL's rolling day): slow poll
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const results = await Promise.allSettled(DEXES.map((dex) => info.metaAndAssetCtxs(dex ? { dex } : undefined)));
      if (!alive) return;
      setPrevDay((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          const [meta, ctxs] = r.value;
          meta.universe.forEach((u, i) => {
            const px = Number(ctxs[i]?.prevDayPx);
            if (px > 0) next[u.name] = px;
          });
        }
        return next;
      });
    };
    load();
    const id = setInterval(load, PREV_DAY_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const results = await Promise.allSettled(DEXES.map((dex) => info.allMids(dex ? { dex } : undefined)));
      if (!alive) return;
      setMids((prev) => {
        const next = { ...prev };
        for (const r of results) if (r.status === "fulfilled") Object.assign(next, r.value);
        return next;
      });
    };
    load();
    const id = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [everyMs]);

  return TICKERS.map((t) => {
    const now = Number(mids[t.coin]);
    const before = prevDay[t.coin];
    const change = now && before ? (now > before ? "up" : now < before ? "down" : "flat") : undefined;
    return {
      src: `/tickers/white/${t.label}.svg`,
      alt: t.label,
      price: now ? formatPrice(now) : "…",
      change,
    };
  });
}

/** Live HYPE price in USD (HyperCore mainnet mid), for showing HYPE-priced launched tokens in dollars. 0 until loaded. */
export function useHypeUsd(everyMs = 15_000): number {
  const [px, setPx] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      info.allMids().then((m) => {
        const v = Number(m.HYPE);
        if (alive && v > 0) setPx(v);
      }, () => {});
    load();
    const id = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [everyMs]);
  return px;
}
