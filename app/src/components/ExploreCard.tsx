// /explore — launched tokens. Three columns, the chart dead-center (side cards are equal width):
//   left card:  Top 25 by total volume (order re-ranked every 30 min by the database; numbers live)
//   above the chart: search @handle (FTF names later)
//   center:     the picked token (header, price + 24h change, market-cap candle chart 5m-4H, stats, curve progress)
//   right card: order card (buy/sell)
//   under the chart (same width): your positions
// `/explore?t=<handle|address>` opens a token (e.g. right after its launch). `?demo` (dev) = sample data.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Search, UserRound } from "lucide-react";
import { CATEGORIES } from "../lib/launch";
import { CandleChart, type ChartControls } from "./CandleChart";
import { subscribeTrades, useLivePrices } from "../lib/live";
import { tokenCreatorEarned } from "../lib/fees";
import { formatEther, type Address } from "viem";
import { OrderCard } from "./OrderCard";
import { PositionsCard } from "./PositionsCard";
import { ProfileModal } from "./ProfileModal";
import { Avatar } from "./Avatar";
import { compactUsd, tinyPrice } from "../lib/format";
import { useHypeUsd } from "../lib/tickers";
import {
  type Candle,
  candles,
  change24h,
  DEMO,
  displayName,
  getToken,
  INTERVALS,
  type IntervalSeconds,
  searchTokens,
  topByTotalVolume,
  type TokenStat,
} from "../lib/explore";

const START = new URLSearchParams(location.search).get("t");

export function ExploreCard() {
  const hypeUsd = useHypeUsd();
  const [top, setTop] = useState<TokenStat[] | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const live = useLivePrices(); // every token's latest price from the live feed
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TokenStat[] | null>(null);
  const [picked, setPicked] = useState<TokenStat | null>(null);
  const [error, setError] = useState<string | null>(null);

  // top list (refreshes every 30 s); picks #1 unless ?t= names a token
  useEffect(() => {
    let alive = true;
    const load = () =>
      topByTotalVolume().then(
        ({ tokens: rows, snapshotAt: at }) => {
          if (!alive) return;
          setTop(rows);
          setSnapshotAt(at);
          setError(null);
          setPicked((p) => p ?? (START ? null : rows[0] ?? null));
        },
        (e) => alive && setError(String(e.message ?? e)),
      );
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (START) getToken(START).then((t) => t && setPicked(t), () => {});
  }, []);

  // keep the picked token's stats fresh: every 4 s while it's a brand-new token shown from the chain (swap in its
  // Supabase record as soon as the indexer stores it), then every 15 s (volume, trades, curve progress)
  useEffect(() => {
    if (!picked) return;
    const address = picked.address;
    const id = setInterval(() => {
      getToken(address, { chainFallback: false }).then((t) => t && setPicked((p) => (p?.address === address ? t : p)), () => {});
    }, picked.fromChain ? 4_000 : 15_000);
    return () => clearInterval(id);
  }, [picked?.address, picked?.fromChain]);

  // search as you type (debounced)
  useEffect(() => {
    if (!query.trim()) return setResults(null);
    let alive = true;
    const id = setTimeout(() => searchTokens(query).then((r) => alive && setResults(r), () => {}), 200);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [query]);

  return (
    <div className="ex-grid">
      <section className="panel ex-card ex-list-card">
        <CardBg />
        <div className="ex-list-head">
          <span>Top 25 · total volume</span>
          <span>MCAP</span>
        </div>
        <ol className="ex-list">
          {top?.map((t, i) => (
            <li key={t.address}>
              <button className={`ex-row${picked?.address === t.address ? " is-picked" : ""}`} onClick={() => setPicked(t)}>
                <span className="ex-rank">{i + 1}</span>
                <Avatar handle={t.handle} pfp={t.x_pfp_url} size={28} />
                <span className="ex-row-names">
                  <span className="ex-row-handle">{displayName(t)}</span>
                  <Change t={t} price={live[t.address]} />
                </span>
                <span className="ex-row-mcap">{hypeUsd ? compactUsd((live[t.address] ?? t.price_hype) * 1e9 * hypeUsd) : "…"}</span>
              </button>
            </li>
          ))}
          {top && top.length === 0 && <li className="ex-empty">No tokens traded yet.</li>}
          {!top && !error && <li className="ex-empty">Loading…</li>}
          {error && <li className="ex-empty">Couldn't load tokens.</li>}
        </ol>
        {snapshotAt && <p className="ex-list-foot">Ranked {ago(snapshotAt)} · every 30 min</p>}
      </section>

      <div className="ex-center">
        <div className="ex-search-top">
          <label className="ex-search">
            <Search size={15} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search @handle or FTF"
              spellCheck={false}
            />
          </label>
          {results && (
            <ul className="ex-results">
              {results.map((t) => (
                <li key={t.address}>
                  <button
                    className="ex-row"
                    onClick={() => {
                      setPicked(t);
                      setQuery("");
                    }}
                  >
                    <span className="ex-rank" />
                    <Avatar handle={t.handle} pfp={t.x_pfp_url} size={28} />
                    <span className="ex-row-names">
                      <span className="ex-row-handle">{displayName(t)}</span>
                      <Change t={t} price={live[t.address]} />
                    </span>
                    <span className="ex-row-mcap">{hypeUsd ? compactUsd((live[t.address] ?? t.price_hype) * 1e9 * hypeUsd) : "…"}</span>
                  </button>
                </li>
              ))}
              {results.length === 0 && <li className="ex-empty">No handle matches.</li>}
            </ul>
          )}
        </div>
      <section className="panel ex-card ex-detail-card">
        <CardBg side="center" />
        {picked ? <TokenDetail key={picked.address} t={picked} hypeUsd={hypeUsd} /> : <p className="ex-empty">Pick a token.</p>}
      </section>
      </div>

      <section className="panel ex-card ex-positions-card">
        <CardBg side="top" />
        <PositionsCard
          hypeUsd={hypeUsd}
          onPick={(address) => {
            const known = top?.find((x) => x.address === address);
            if (known) setPicked(known);
            else getToken(address).then((x) => x && setPicked(x), () => {});
          }}
        />
      </section>

      <section className="panel ex-card ex-order-card">
        <CardBg side="left" />
        <OrderCard key={picked?.address} t={picked} hypeUsd={hypeUsd} />
      </section>
    </div>
  );
}

function TokenDetail({ t, hypeUsd }: { t: TokenStat; hypeUsd: number }) {
  const [interval, setInterval_] = useState<IntervalSeconds>(900);
  const [data, setData] = useState<Candle[] | null>(null);
  const [controls, setControls] = useState<ChartControls | null>(null);
  const [log, setLog] = useState(false);
  const [showProfile, setShowProfile] = useState(false);

  // lifetime creator fees this token has earned (FeeVault.creatorEarned), shown next to the Profile button
  const [earned, setEarned] = useState<number | null>(null);
  useEffect(() => {
    if (DEMO) return setEarned(t.volume_usd / 90 * 0.0075 * 0.8); // demo: ~80% of 0.75% of its volume, in HYPE
    let alive = true;
    const load = () => tokenCreatorEarned(t.address as Address).then((w) => alive && setEarned(Number(formatEther(w))), () => {});
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [t.address, t.volume_usd]);
  const closeProfile = useCallback(() => setShowProfile(false), []);
  // HYPE/USD frozen for this token's chart (the live rate still drives the header price)
  const [chartUsd, setChartUsd] = useState(0);
  useEffect(() => {
    if (!chartUsd && hypeUsd) setChartUsd(hypeUsd);
  }, [hypeUsd, chartUsd]);

  // live trades (watcher -> Realtime): move the chart's current candle and the header price as blocks land
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [liveTrades, setLiveTrades] = useState(0);
  const startPrice = useRef(t.price_hype); // demo feed's starting point; refreshed stats mustn't restart the feed
  useEffect(() => {
    if (!controls) return;
    return subscribeTrades(
      t.address,
      (trade) => {
        if (trade.priceHype != null) setLivePrice(trade.priceHype);
        setLiveTrades((n) => n + 1);
        controls.applyTrade(trade);
      },
      startPrice.current,
    );
  }, [controls, t.address]);
  const price = livePrice ?? t.price_hype;

  // stored candles: tiny reads, so refresh often; keep showing the last data while a refresh loads
  useEffect(() => {
    let alive = true;
    setData(null);
    const load = () => candles(t.address, interval, 300).then((c) => alive && setData(c), () => {});
    load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [t.address, interval]);

  const cat = CATEGORIES.find((c) => c.id === t.category)?.label ?? t.category;
  const usdOr = (hype: number) => (hypeUsd ? compactUsd(hype * hypeUsd) : "…");
  return (
    <div className="ex-detail">
      <header className="ex-head">
        <Avatar handle={t.handle} pfp={t.x_pfp_url} size={44} />
        <div className="ex-head-names">
          <span className="ex-handle">{displayName(t)}</span>
          <span className="ex-ticker">${t.symbol}</span>
        </div>
        <span className={`lp-chip${t.kind === "ftf" ? " ex-ftf-chip" : ""}`}>{t.kind === "ftf" ? "FTF" : cat}</span>
        <button className="ex-profile-btn" onClick={() => setShowProfile(true)}>
          <UserRound size={13} aria-hidden /> Profile
        </button>
        <span className="ex-earned" title="Lifetime creator fees: 80% of this token's trading fees, paid in HYPE">
          <span className="ex-earned-label">Creator fees earned</span>
          <span className="ex-earned-value">
            {earned === null ? "…" : hypeUsd ? compactUsd(earned * hypeUsd) : `${earned.toFixed(4)} HYPE`}
            {earned !== null && hypeUsd ? <span className="ex-earned-hype"> · {earned.toLocaleString("en-US", { maximumFractionDigits: 4 })} HYPE</span> : null}
          </span>
        </span>
        <div className="ex-price">
          <span className="ex-price-usd">{hypeUsd ? tinyPrice(price * hypeUsd) : "…"}</span>
          <Change t={t} price={price} />
        </div>
      </header>

      <div className="ex-chart-bar">
        {INTERVALS.map((x) => (
          <button key={x.s} className={`ex-range${x.s === interval ? " is-on" : ""}`} onClick={() => setInterval_(x.s)}>
            {x.label}
          </button>
        ))}
        <span className="ex-chart-label">Market cap (USD)</span>
        <button
          className={`ex-range${log ? " is-on" : ""}`}
          onClick={() => {
            controls?.setLog(!log);
            setLog(!log);
          }}
        >
          Log
        </button>
        <button className="ex-range" onClick={() => controls?.reset()}>
          Reset
        </button>
      </div>
      <div className="ex-chart">
        <CandleChart candles={data} interval={interval} hypeUsd={chartUsd} basePriceHype={t.price_hype} onControls={setControls} />
        {data && data.length === 0 && liveTrades === 0 && <p className="ex-empty ex-chart-empty">No trades yet.</p>}
      </div>

      <dl className="ex-stats">
        <div><dt>Market cap</dt><dd>{usdOr(price * 1e9)}</dd></div>
        <div><dt>24h volume</dt><dd>{compactUsd(t.volume_usd_24h)}</dd></div>
        <div><dt>All-time volume</dt><dd>{compactUsd(t.volume_usd)}</dd></div>
        <div><dt>24h trades</dt><dd>{t.trades_24h.toLocaleString("en-US")}</dd></div>
        <div><dt>Launched</dt><dd>{ago(t.launched_at)}</dd></div>
      </dl>

      <div className="ex-progress">
        <div className="ex-progress-label">
          <span>{t.graduated ? "Graduated to the pool" : "Bonding curve"}</span>
          <span>{Math.floor(t.curve_progress * 100)}%</span>
        </div>
        <div className="ex-progress-track">
          <span style={{ width: `${Math.min(100, t.curve_progress * 100)}%` }} />
        </div>
      </div>
      <AnimatePresence>{showProfile && <ProfileModal t={t} onClose={closeProfile} />}</AnimatePresence>
    </div>
  );
}

/** 24h change; `price` = a newer (live) price than the stats'. */
function Change({ t, price }: { t: TokenStat; price?: number }) {
  const c = price != null && t.price_hype_24h_ago > 0 ? (price / t.price_hype_24h_ago - 1) * 100 : change24h(t);
  if (c == null) return <span className="ex-change">—</span>;
  return <span className={`ex-change ${c >= 0 ? "price-up" : "price-down"}`}>{`${c >= 0 ? "+" : ""}${c.toFixed(1)}%`}</span>;
}

/** The /launch cards' background: lavender tint + dot grid. `side` = where it glows (each card faces the page center). */
function CardBg({ side = "right" }: { side?: "left" | "center" | "right" | "top" }) {
  return (
    <div className={`li-bg ex-bg-${side}`} aria-hidden>
      <span className="li-tint" />
      <span className="li-dots" />
    </div>
  );
}

function ago(iso: string) {
  const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
