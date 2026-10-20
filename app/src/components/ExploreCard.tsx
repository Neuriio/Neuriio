// /explore — launched tokens. Three columns, the chart dead-center (side cards are equal width):
//   left card:  platform fees (lifetime, every token; not on the landing), then Top 25 by total volume (order re-ranked
//               every minute by the database; numbers live)
//   above the chart: search @handle (FTF names later)
//   center:     the picked token (header, price + 24h change, market-cap candle chart 5m-4H, stats, curve progress)
//   right card: order card (buy/sell); beside it (the app, not the landing): stake / unstake / claim
//   under the chart (same width): your positions
// Phones (<= 860px): search, the chart card (no Profile button, no Log/Reset), then one card with four tabs:
//   About (creator profile, bio, creator fees, stats, curve progress) · Trade (the order card) · Stake (the stake card)
//   · Positions.
//   The Top 25 moves to /trending on phones.
// `/explore?t=<handle|address>` opens a token (e.g. right after its launch). `?demo` (dev) = sample data.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { ExternalLink, Search, UserRound } from "lucide-react";
import { CATEGORIES, SECTORS } from "../lib/launch";
import { CandleChart, type ChartControls } from "./CandleChart";
import { subscribeTrades, useLivePrices } from "../lib/live";
import { platformFees, tokenCreatorEarned } from "../lib/fees";
import { formatUnits, type Address } from "viem";
import { OrderCard } from "./OrderCard";
import { GraduatingOverlay, ownGraduations, type GradStage } from "./GraduatingOverlay";
import { PositionsCard } from "./PositionsCard";
import { StakeCard } from "./StakeCard";
import { ProfileBody, ProfileModal, useCreatorProfile } from "./ProfileModal";
import { useIsMobile } from "../lib/media";
import { Avatar } from "./Avatar";
import { compactUsd, tinyPrice, usd } from "../lib/format";
import { QUOTE } from "../lib/config";
import {
  type Candle,
  candles,
  change24h,
  DEMO,
  LANDING,
  SHOW_HYPE_USD,
  displayName,
  getToken,
  handleOf,
  INTERVALS,
  type IntervalSeconds,
  searchTokens,
  tickerOf,
  topByTotalVolume,
  type TokenStat,
} from "../lib/explore";

const START = new URLSearchParams(location.search).get("t");

export function ExploreCard() {
  // launched tokens are priced in USDC ($1); the landing's sample data is in HYPE at a fixed price
  const hypeUsd = LANDING ? SHOW_HYPE_USD : QUOTE.usd;
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
    const id = setInterval(load, 20_000); // the database re-ranks every minute
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

  const mobile = useIsMobile();
  const pickPosition = (address: string) => {
    const known = top?.find((x) => x.address === address);
    if (known) setPicked(known);
    else getToken(address).then((x) => x && setPicked(x), () => {});
  };

  // the search sits in the header (App's #top-search), on every screen size; the landing keeps it above the chart
  const [searchSlot, setSearchSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSearchSlot(LANDING ? null : document.getElementById("top-search")), []);
  const search = (
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
  );

  const center = (
    <div className="ex-center">
      {searchSlot ? createPortal(search, searchSlot) : search}
      <section className="panel ex-card ex-detail-card">
        <CardBg side="center" />
        {picked ? (
          <TokenDetail
            key={picked.address}
            t={picked}
            hypeUsd={hypeUsd}
            // it graduated live: switch to pool trading now (the indexer stores it within a minute)
            onGraduated={(pair) => setPicked((p) => (p && p.address === picked.address ? { ...p, graduated: true, pair, curve_progress: 1 } : p))}
            compact={mobile}
          />
        ) : (
          <p className="ex-empty">Pick a token.</p>
        )}
      </section>
    </div>
  );

  if (mobile)
    return (
      <div className="ex-grid">
        {center}
        <MobileTabs t={picked} hypeUsd={hypeUsd} price={picked ? live[picked.address] : undefined} onPick={pickPosition} />
      </div>
    );

  return (
    <div className="ex-grid">
      <section className="panel ex-card ex-list-card">
        <CardBg />
        {!LANDING && <PlatformFees />}
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
        {snapshotAt && <p className="ex-list-foot">Ranked {ago(snapshotAt)} · every minute</p>}
      </section>

      {center}

      <section className="panel ex-card ex-positions-card">
        <CardBg side="top" />
        <PositionsCard hypeUsd={hypeUsd} onPick={pickPosition} />
      </section>

      <section className="panel ex-card ex-order-card">
        <CardBg side="left" />
        <OrderCard key={picked?.address} t={picked} hypeUsd={hypeUsd} />
      </section>

      {!LANDING && (
        <section className="panel ex-card ex-stake-card">
          <StakeCard key={picked?.address} t={picked} />
        </section>
      )}
    </div>
  );
}

type MobileTab = "about" | "trade" | "stake" | "positions";
const MOBILE_TABS: { id: MobileTab; label: string }[] = [
  { id: "about", label: "About" },
  { id: "trade", label: "Trade" },
  { id: "stake", label: "Stake" },
  { id: "positions", label: "Positions" },
];

/** Phones: one card under the chart with About / Trade / Stake / Positions. All of them stay mounted (hidden when not
 *  picked), so switching tabs keeps a typed amount. `price` = the live price, newer than the stats'. */
function MobileTabs({
  t,
  hypeUsd,
  price,
  onPick,
}: {
  t: TokenStat | null;
  hypeUsd: number;
  price?: number;
  onPick: (address: string) => void;
}) {
  const [tab, setTab] = useState<MobileTab>("about");
  return (
    <section className="panel ex-card ex-mtabs-card">
      <CardBg side="top" />
      <div className="ex-mtabs" role="tablist">
        {MOBILE_TABS.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={`ex-mtab${tab === x.id ? " is-on" : ""}`} onClick={() => setTab(x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      <div hidden={tab !== "about"}>
        {t ? <AboutTab key={t.address} t={t} hypeUsd={hypeUsd} price={price ?? t.price_hype} /> : <p className="ex-empty">Pick a token.</p>}
      </div>
      <div hidden={tab !== "trade"}>
        <OrderCard key={t?.address} t={t} hypeUsd={hypeUsd} />
      </div>
      <div hidden={tab !== "stake"} className="ex-mtab-stake">
        <StakeCard key={t?.address} t={t} />
      </div>
      <div hidden={tab !== "positions"} className="ex-mtab-positions">
        <PositionsCard hypeUsd={hypeUsd} onPick={onPick} bare />
      </div>
    </section>
  );
}

/** Mobile About tab: who launched it (X link), bio + links, creator fees, the stats and curve progress. */
function AboutTab({ t, hypeUsd, price }: { t: TokenStat; hypeUsd: number; price: number }) {
  const { profile, members } = useCreatorProfile(t);
  const earned = useCreatorEarned(t);
  const usdOr = (hype: number) => (hypeUsd ? compactUsd(hype * hypeUsd) : "…");
  return (
    <div className="ex-about">
      <header className="ex-modal-head">
        <Avatar handle={t.kind === "ftf" ? t.name ?? t.symbol : t.handle} pfp={t.x_pfp_url} size={52} className="ex-modal-avatar" />
        <div className="ex-head-names">
          <span className="ex-handle">{t.kind === "ftf" ? t.name : t.x_name || handleOf(t.handle)}</span>
          {t.kind === "ftf" ? (
            <span className="ex-ticker">{tickerOf(t.symbol)} · Friends Turned Fam</span>
          ) : (
            <a className="ex-modal-x" href={`https://x.com/${t.handle}`} target="_blank" rel="noreferrer">
              {handleOf(t.handle)} on X <ExternalLink size={11} />
            </a>
          )}
        </div>
      </header>

      <ProfileBody t={t} profile={profile} members={members} />

      <section className="ex-modal-section">
        <h3 className="ex-modal-label">Creator fees earned</h3>
        <span className="ex-earned-value">
          {earned === null ? "…" : compactUsd(earned * hypeUsd)}
        </span>
      </section>

      <dl className="ex-stats">
        <div><dt>Market cap</dt><dd>{usdOr(price * 1e9)}</dd></div>
        <div><dt>24h volume</dt><dd>{compactUsd(t.volume_usd_24h)}</dd></div>
        <div><dt>All-time volume</dt><dd>{compactUsd(t.volume_usd)}</dd></div>
        <div><dt>24h trades</dt><dd>{t.trades_24h.toLocaleString("en-US")}</dd></div>
        <div><dt>Launched</dt><dd>{ago(t.launched_at)}</dd></div>
      </dl>

      <Progress t={t} />

      <p className="ex-order-note">
        {displayName(t)} is a meme with no promise of value. {t.kind === "ftf" ? "Its members owe" : `${handleOf(t.handle)} owes`} holders nothing.
      </p>
    </div>
  );
}

/** Every fee the platform has taken so far (NeuriioFees.totalFees, all vaults), in USDC; refreshed every 15 s. */
function PlatformFees() {
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    if (DEMO) return setTotal(48_213.37);
    let alive = true;
    const load = () => platformFees().then((w) => alive && setTotal(Number(formatUnits(w, QUOTE.decimals))), () => {});
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return (
    <div className="ex-platform" title="Every 1% trading fee taken so far, curve and pool, all tokens: shared with stakers, creators, the KNTQ buyback and the treasury">
      <span className="ex-platform-label">Platform fees</span>
      <span className="ex-platform-value">{total === null ? "…" : usd(total * QUOTE.usd)}</span>
    </div>
  );
}

/** Lifetime creator fees this token has earned (NeuriioFees.creatorEarned), in USDC (the landing's samples: HYPE);
 *  null while loading. */
function useCreatorEarned(t: TokenStat) {
  const [earned, setEarned] = useState<number | null>(null);
  useEffect(() => {
    if (DEMO) return setEarned((t.volume_usd / (LANDING ? SHOW_HYPE_USD : QUOTE.usd)) * 0.01 * 0.1); // demo: 10% of a 1% fee
    let alive = true;
    const load = () => tokenCreatorEarned(t.address as Address).then((w) => alive && setEarned(Number(formatUnits(w, QUOTE.decimals))), () => {});
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [t.address, t.volume_usd]);
  return earned;
}

function Progress({ t }: { t: TokenStat }) {
  return (
    <div className="ex-progress">
      <div className="ex-progress-label">
        <span>{t.graduated ? "Graduated to the pool" : "Bonding curve"}</span>
        <span>{Math.floor(t.curve_progress * 100)}%</span>
      </div>
      <div className="ex-progress-track">
        <span style={{ width: `${Math.min(100, t.curve_progress * 100)}%` }} />
      </div>
    </div>
  );
}

/** `compact` (phones): header + timeframes + chart only; profile, fees, stats and progress live in the About tab. */
function TokenDetail({
  t,
  hypeUsd,
  onGraduated,
  compact = false,
}: {
  t: TokenStat;
  hypeUsd: number;
  onGraduated: (pair: string) => void;
  compact?: boolean;
}) {
  const [grad, setGrad] = useState<GradStage>(null); // everyone watching sees the graduation (the buyer's own is in OrderCard)
  const [interval, setInterval_] = useState<IntervalSeconds>(300); // 5m: a token's first candle, then every timeframe from there
  const [data, setData] = useState<Candle[] | null>(null);
  const [controls, setControls] = useState<ChartControls | null>(null);
  const [log, setLog] = useState(false);
  const [showProfile, setShowProfile] = useState(false);

  const earned = useCreatorEarned(t); // shown next to the Profile button
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
      (g) => {
        onGraduated(g.pair);
        if (ownGraduations.has(g.token)) return;
        setGrad("graduating");
        setTimeout(() => setGrad("graduated"), 1600);
        setTimeout(() => setGrad(null), 3800);
      },
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
  const sector = SECTORS.find((x) => x.id === t.sector)?.label;
  const usdOr = (hype: number) => (hypeUsd ? compactUsd(hype * hypeUsd) : "…");
  return (
    <div className="ex-detail">
      <GraduatingOverlay stage={grad} name={displayName(t)} />
      <header className="ex-head">
        <Avatar handle={t.handle} pfp={t.x_pfp_url} size={44} />
        <div className="ex-head-names">
          <span className="ex-handle">{displayName(t)}</span>
          <span className="ex-ticker">{tickerOf(t.symbol)}</span>
        </div>
        <span className="ex-chips">
          {sector && <span className="lp-chip ex-sector-chip">{sector}</span>}
          <span className={`lp-chip${t.kind === "ftf" ? " ex-ftf-chip" : ""}`}>{t.kind === "ftf" ? "FTF" : cat}</span>
        </span>
        {!compact && (
          <>
            <button className="ex-profile-btn" onClick={() => setShowProfile(true)}>
              <UserRound size={13} aria-hidden /> Profile
            </button>
            <span className="ex-earned" title="Lifetime creator fees: 10% of every trading fee, on the curve and in the pool, paid in USDC">
              <span className="ex-earned-label">Creator fees earned</span>
              <span className="ex-earned-value">
                {earned === null ? "…" : compactUsd(earned * hypeUsd)}
              </span>
            </span>
          </>
        )}
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
        {!compact && (
          <>
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
          </>
        )}
      </div>
      <div className="ex-chart">
        <CandleChart candles={data} interval={interval} hypeUsd={chartUsd} basePriceHype={t.price_hype} onControls={setControls} fit={LANDING} />
        {data && data.length === 0 && liveTrades === 0 && <p className="ex-empty ex-chart-empty">No trades yet.</p>}
      </div>
      <p className="ex-chart-credit">
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
          Charts by TradingView
        </a>
      </p>

      {!compact && (
        <>
          <dl className="ex-stats">
            <div><dt>Market cap</dt><dd>{usdOr(price * 1e9)}</dd></div>
            <div><dt>24h volume</dt><dd>{compactUsd(t.volume_usd_24h)}</dd></div>
            <div><dt>All-time volume</dt><dd>{compactUsd(t.volume_usd)}</dd></div>
            <div><dt>24h trades</dt><dd>{t.trades_24h.toLocaleString("en-US")}</dd></div>
            <div><dt>Launched</dt><dd>{ago(t.launched_at)}</dd></div>
          </dl>
          <Progress t={t} />
        </>
      )}
      <AnimatePresence>{showProfile && <ProfileModal t={t} onClose={closeProfile} />}</AnimatePresence>
    </div>
  );
}

/** 24h change; `price` = a newer (live) price than the stats'. */
export function Change({ t, price }: { t: TokenStat; price?: number }) {
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

export function ago(iso: string) {
  const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
