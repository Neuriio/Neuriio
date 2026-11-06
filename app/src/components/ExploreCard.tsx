// /explore — launched tokens. Three columns, the chart dead-center (side cards are equal width):
//   left card:  Trending, the top 25 Ascend coins by 24h volume (ours and everyone else's; refreshed every 20 s, prices live;
//               user 2026-11-05: replaces the /trending page and the Platform fees counter)
//   above the chart: search @handle (FTF names later)
//   center:     the picked token (header, price + 24h change, stats, market-cap candle chart 5m-4H)
//   right card: Buy / Sell / Stake tabs (the landing: just the order card)
//   under the chart (same width): your positions
// Phones (<= 860px): search, the chart card (no Profile button), then one card with four tabs:
//   About (creator profile, bio, creator fees) · Trade (the order card) · Stake (the stake card) · Positions.
//   The Trending list sits under those tabs on phones.
// `/explore?t=<handle|address>` opens a token (e.g. right after its launch). `?demo` (dev) = sample data.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { ExternalLink, Search, UserRound } from "lucide-react";
import { CATEGORIES, SECTORS } from "../lib/launch";
import { CandleChart, type ChartControls } from "./CandleChart";
import { agoraCandles } from "../lib/agora";
import { subscribeTrades, useLivePrices } from "../lib/live";
import { tokenCreatorEarned } from "../lib/fees";
import { formatUnits, type Address } from "viem";
import { OrderCard } from "./OrderCard";
import { GraduatingOverlay, ownGraduations, type GradStage } from "./GraduatingOverlay";
import { PositionsCard } from "./PositionsCard";
import { StakeCard } from "./StakeCard";
import { ProfileBody, ProfileModal, useCreatorProfile } from "./ProfileModal";
import { useIsMobile } from "../lib/media";
import { Avatar } from "./Avatar";
import { compactUsd, tinyPrice } from "../lib/format";
import { QUOTE } from "../lib/config";
import {
  type Candle,
  candles,
  change24h,
  DEMO,
  LANDING,
  SHOW_HYPE_USD,
  displayName,
  isOurs,
  getToken,
  handleOf,
  INTERVALS,
  type IntervalSeconds,
  searchTokens,
  tickerOf,
  agoraTrending,
  elsewhereName,
  elsewhereUrl,
  type TokenStat,
} from "../lib/explore";
import { poll } from "../lib/poll";

const START = new URLSearchParams(location.search).get("t");

export function ExploreCard() {
  // launched tokens are priced in USDC ($1); the landing's sample data is in HYPE at a fixed price
  const hypeUsd = LANDING ? SHOW_HYPE_USD : QUOTE.usd;
  const [top, setTop] = useState<TokenStat[] | null>(null);
  const live = useLivePrices(); // every token's latest price from the live feed
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TokenStat[] | null>(null);
  const [picked, setPicked] = useState<TokenStat | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Trending (user, 2026-11-05, replacing the /trending page): the top 25 Ascend coins by 24h volume, ours and everyone else's
  // (refreshes every 20 s); picks #1 unless ?t= names a token
  useEffect(() => {
    let alive = true;
    const load = () =>
      agoraTrending().then(
        (rows) => {
          if (!alive) return;
          setTop(rows);
          setError(null);
          setPicked((p) => p ?? (START ? null : rows[0] ?? null));
        },
        (e) => alive && setError(String(e.message ?? e)),
      );
    const stop = poll(load, 20_000);
    return () => {
      alive = false;
      stop();
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
    const load = () =>
      getToken(address, { chainFallback: false }).then((t) => t && setPicked((p) => (p?.address === address ? t : p)), () => {});
    return poll(load, picked.fromChain ? 4_000 : 15_000, { now: false });
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

  const trending = (
    <section className="panel ex-card ex-list-card">
      <CardBg />
      <TrendingList rows={top} error={!!error} picked={picked} live={live} hypeUsd={hypeUsd} onPick={setPicked} />
    </section>
  );

  if (mobile)
    return (
      <div className="ex-grid">
        <div className="ex-main">
          {center}
          <MobileTabs t={picked} hypeUsd={hypeUsd} onPick={pickPosition} />
          {trending}
        </div>
      </div>
    );

  return (
    <div className="ex-grid">
      {/* separate widgets: list | chart | buy/sell/stake, with Positions below (user, 2026-11-01). The trade page will
          reuse this shell. */}
      <div className="ex-main">
        {trending}

        {center}

        <section className="panel ex-card ex-order-card">
          <CardBg side="left" />
          {LANDING ? <OrderCard key={picked?.address} t={picked} hypeUsd={hypeUsd} /> : <TradeTabs t={picked} hypeUsd={hypeUsd} />}
        </section>
      </div>

      <section className="panel ex-card ex-positions-card">
        <CardBg side="top" />
        <PositionsCard hypeUsd={hypeUsd} onPick={pickPosition} />
      </section>
    </div>
  );
}

/** Desktop: one widget with Buy / Sell / Stake tabs. Both cards stay mounted, so switching to Stake and back keeps a
 *  typed amount. */
function TradeTabs({ t, hypeUsd }: { t: TokenStat | null; hypeUsd: number }) {
  const [tab, setTab] = useState<"buy" | "sell" | "stake">("buy");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const pick = (x: "buy" | "sell" | "stake") => {
    setTab(x);
    if (x !== "stake") setSide(x);
  };
  return (
    <div className="ex-trade">
      <div className="ex-order-tabs ex-trade-tabs" role="tablist">
        {(["buy", "sell", "stake"] as const).map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={`ex-order-tab is-${x}${tab === x ? " is-on" : ""}`} onClick={() => pick(x)}>
            {x === "buy" ? "Buy" : x === "sell" ? "Sell" : "Stake"}
          </button>
        ))}
      </div>
      <div className="ex-trade-body" hidden={tab === "stake"}>
        <OrderCard key={t?.address} t={t} hypeUsd={hypeUsd} fixedSide={side} />
      </div>
      <div className="ex-trade-body" hidden={tab !== "stake"}>
        <StakeCard key={t?.address} t={t} />
      </div>
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
 *  picked), so switching tabs keeps a typed amount. */
function MobileTabs({
  t,
  hypeUsd,
  onPick,
}: {
  t: TokenStat | null;
  hypeUsd: number;
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
        {t ? <AboutTab key={t.address} t={t} hypeUsd={hypeUsd} /> : <p className="ex-empty">Pick a token.</p>}
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

/** Mobile About tab: who launched it (X link), bio + links and creator fees. */
function AboutTab({ t, hypeUsd }: { t: TokenStat; hypeUsd: number }) {
  const { profile, members } = useCreatorProfile(t);
  const earned = useCreatorEarned(t);
  return (
    <div className="ex-about">
      <header className="ex-modal-head">
        <Avatar handle={t.kind === "ftf" ? t.name ?? t.symbol : t.handle} pfp={t.x_pfp_url} size={52} className="ex-modal-avatar" />
        <div className="ex-head-names">
          <span className="ex-handle">{!isOurs(t) ? displayName(t) : t.kind === "ftf" ? t.name : t.x_name || handleOf(t.handle)}</span>
          {!isOurs(t) ? (
            <a className="ex-modal-x" href={elsewhereUrl(t)} target="_blank" rel="noreferrer">
              Not launched on Neuriio · view on {elsewhereName(t)} <ExternalLink size={11} />
            </a>
          ) : t.kind === "ftf" ? (
            <span className="ex-ticker">{tickerOf(t.symbol)} · Friends Turned Fam</span>
          ) : (
            <a className="ex-modal-x" href={`https://x.com/${t.handle}`} target="_blank" rel="noreferrer">
              {handleOf(t.handle)} on X <ExternalLink size={11} />
            </a>
          )}
        </div>
      </header>

      {isOurs(t) && <ProfileBody t={t} profile={profile} members={members} />}

      <section className="ex-modal-section">
        <h3 className="ex-modal-label">Creator fees earned</h3>
        <span className="ex-earned-value">
          {earned === null ? "…" : compactUsd(earned * hypeUsd)}
        </span>
      </section>

      <p className="ex-order-note">
        {!isOurs(t)
          ? `${displayName(t)} was launched on ${t.venue ?? (t.source === "agora" ? "another launchpad" : "Ascend")}, not through Neuriio. It's a meme with no promise of value.`
          : `${displayName(t)} is a meme with no promise of value. ${t.kind === "ftf" ? "Its members owe" : `${handleOf(t.handle)} owes`} holders nothing.`}
      </p>
    </div>
  );
}

/** Explore's list (user, 2026-11-05, replacing the /trending page): the top 25 Ascend coins by 24h volume, ours with the Neuriio
 *  logo and everyone else's marked "(Not Launched On Neuriio)", as the Trending page showed them. Picking a row opens it here. */
function TrendingList({
  rows,
  error,
  picked,
  live,
  hypeUsd,
  onPick,
}: {
  rows: TokenStat[] | null;
  error: boolean;
  picked: TokenStat | null;
  live: Record<string, number>;
  hypeUsd: number;
  onPick: (t: TokenStat) => void;
}) {
  return (
    <>
      <div className="ex-list-head">
        <span>
          <span className="tr-title">Trending</span> · 24h volume
        </span>
        <span>MCAP</span>
      </div>
      <ol className="ex-list">
        {rows?.map((t, i) => (
          <li key={t.address}>
            <button className={`ex-row${picked?.address === t.address ? " is-picked" : ""}`} onClick={() => onPick(t)}>
              <span className="ex-rank">{i + 1}</span>
              <Avatar handle={t.handle} pfp={t.x_pfp_url} size={28} />
              <span className="ex-row-names">
                <span className="ex-row-handle tr-name">
                  <span className="tr-name-text">{displayName(t)}</span>
                  {isOurs(t) ? (
                    <img className="tr-ours" src="/brand/logo.png" alt="Launched on Neuriio" title="Launched on Neuriio" />
                  ) : (
                    <span className="tr-elsewhere">(Not Launched On Neuriio)</span>
                  )}
                </span>
                <Change t={t} price={live[t.address]} />
              </span>
              <span className="ex-row-mcap">{hypeUsd ? compactUsd((live[t.address] ?? t.price_hype) * 1e9 * hypeUsd) : "…"}</span>
            </button>
          </li>
        ))}
        {rows && rows.length === 0 && <li className="ex-empty">No trades in the last 24 hours.</li>}
        {!rows && !error && <li className="ex-empty">Loading…</li>}
        {error && <li className="ex-empty">Couldn't load tokens.</li>}
      </ol>
      {rows && <p className="ex-list-foot">Top 15 on Elysium by 24h volume · data from Agora</p>}
    </>
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
    const stop = poll(load, 60_000);
    return () => {
      alive = false;
      stop();
    };
  }, [t.address, t.volume_usd]);
  return earned;
}

/** `compact` (phones): header + stats + timeframes + chart only; profile and fees live in the About tab. */
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
  const reloadCandles = useRef<() => void>(() => {});
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
      () => {
        // back from a long-hidden tab: trades in between were missed, so redraw from the stored candles
        setLivePrice(null);
        reloadCandles.current();
      },
    );
  }, [controls, t.address]);
  const price = livePrice ?? t.price_hype;

  // stored candles: tiny reads, so refresh often; keep showing the last data while a refresh loads
  useEffect(() => {
    let alive = true;
    setData(null);
    const load = () => (t.source === "agora" ? agoraCandles : candles)(t.address, interval, 300).then((c) => alive && setData(c), () => {});
    reloadCandles.current = load;
    const stop = poll(load, 10_000);
    return () => {
      alive = false;
      stop();
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
          <span className="ex-handle tr-name">
            <span className="tr-name-text">{displayName(t)}</span>
            {!isOurs(t) && <span className="tr-elsewhere">(Not Launched On Neuriio)</span>}
          </span>
          <span className="ex-ticker">{tickerOf(t.symbol)}</span>
        </div>
        <span className="ex-chips">
          {sector && <span className="lp-chip ex-sector-chip">{sector}</span>}
          {isOurs(t) ? (
            <span className={`lp-chip${t.kind === "ftf" ? " ex-ftf-chip" : ""}`}>{t.kind === "ftf" ? "FTF" : cat}</span>
          ) : (
            <span className="lp-chip">{(t.quote_symbol ?? "USDC").toUpperCase() === "WHYPE" ? "HYPE" : t.quote_symbol ?? "USDC"} pair</span>
          )}
        </span>
        {!compact && (
          <>
            {isOurs(t) ? (
              <button className="ex-profile-btn" onClick={() => setShowProfile(true)}>
                <UserRound size={13} aria-hidden /> Profile
              </button>
            ) : (
              <a className="ex-profile-btn" href={elsewhereUrl(t)} target="_blank" rel="noreferrer">
                <ExternalLink size={13} aria-hidden /> {elsewhereName(t)}
              </a>
            )}
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

      <dl className="ex-stats">
        <div><dt>Market cap</dt><dd>{usdOr(price * 1e9)}</dd></div>
        <div><dt>24h volume</dt><dd>{compactUsd(t.volume_usd_24h)}</dd></div>
        <div><dt>{t.source === "agora" ? "7d volume" : "All-time volume"}</dt><dd>{compactUsd(t.volume_usd)}</dd></div>
        <div><dt>24h trades</dt><dd>{t.trades_24h.toLocaleString("en-US")}</dd></div>
      </dl>

      <div className="ex-chart-bar">
        {INTERVALS.map((x) => (
          <button key={x.s} className={`ex-range${x.s === interval ? " is-on" : ""}`} onClick={() => setInterval_(x.s)}>
            {x.label}
          </button>
        ))}
        {!compact && <span className="ex-chart-label">Market cap (USD)</span>}
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
