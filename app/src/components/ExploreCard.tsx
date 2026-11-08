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
import { ExternalLink, Globe, Search, Send, UserRound } from "lucide-react";
import { CATEGORIES, SECTORS } from "../lib/launch";
import { CandleChart, type ChartControls } from "./CandleChart";
import { subscribeTrades, useLivePrices } from "../lib/live";
import { creatorFees, type CreatorFees } from "../lib/fees";
import { OrderCard } from "./OrderCard";
import { GraduatingOverlay, ownGraduations, type GradStage } from "./GraduatingOverlay";
import { PositionsCard } from "./PositionsCard";
import { StakeCard } from "./StakeCard";
import { ProfileBody, ProfileModal, useCreatorProfile } from "./ProfileModal";
import { TokenArtButton } from "./TokenArtModal";
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
  verifiedTokens,
  tokenLinks,
  type TokenLinks as Links,
  topTokens,
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

  // the list (user, 2026-11-07): "Verified" = Ascend's top 15 tokens by 24h volume (our own chain data); "Neuriio" = our own
  // launches by 24h volume. Refreshes every 20 s; picks #1 of the first load unless ?t= names a token
  const [listMode, setListMode] = useState<ListMode>("verified");
  useEffect(() => {
    let alive = true;
    setTop(null);
    setError(null);
    const load = () =>
      (listMode === "verified" ? verifiedTokens(15) : topTokens("volume_usd_24h", 15)).then(
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
  }, [listMode]);

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
      <TrendingList mode={listMode} onMode={setListMode} rows={top} error={!!error} picked={picked} live={live} hypeUsd={hypeUsd} onPick={setPicked} />
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
 *  typed amount. A Neuriio coin opens on Stake (user, 2026-11-08); others on Buy. */
function TradeTabs({ t, hypeUsd }: { t: TokenStat | null; hypeUsd: number }) {
  const [tab, setTab] = useState<"buy" | "sell" | "stake">("buy");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [shown, setShown] = useState<string | undefined>(undefined);
  if (t?.address !== shown) {
    // a different coin was picked (set during render, so the old tab never flashes): a Neuriio coin opens on Stake; another
    // coin leaves Stake for Buy/Sell and otherwise keeps the tab
    setShown(t?.address);
    setTab(t && isOurs(t) ? "stake" : (was) => (was === "stake" ? side : was));
  }
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
  const [shown, setShown] = useState<string | undefined>(undefined);
  if (t?.address !== shown) {
    // a Neuriio coin opens on Stake (user, 2026-11-08); leaving it for another coin goes back to About, else the tab stays
    setShown(t?.address);
    setTab(t && isOurs(t) ? "stake" : (was) => (was === "stake" ? "about" : was));
  }
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
            <span className="ex-row-sub">
              <span className="ex-ticker">{tickerOf(t.symbol)}</span>
              <VenueChip t={t} />
            </span>
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
      {!isOurs(t) && <TokenLinks t={t} />}

      <section className="ex-modal-section">
        <h3 className="ex-modal-label">Creator fees earned</h3>
        <EarnedValue earned={earned} />
      </section>

      <p className="ex-order-note">
        {!isOurs(t)
          ? `${displayName(t)} was launched on Ascend, not through Neuriio. It's a meme with no promise of value.`
          : `${displayName(t)} is a meme with no promise of value. ${t.kind === "ftf" ? "Its members owe" : `${handleOf(t.handle)} owes`} holders nothing.`}
      </p>
    </div>
  );
}

/** Whether a token trades against HYPE (native HYPE or WHYPE). */
/** A pair shown as a small logo on the coin's picture (bottom-left) instead of a "<X> pair" chip: HYPE (user, 2026-11-07) and
 *  KNTQ (Kinetiq's logo, user 2026-11-08). */
const PAIR_BADGES: Record<string, { src: string; name: string; cls?: string }> = {
  HYPE: { src: "/pairs/hype.svg", name: "HYPE" },
  WHYPE: { src: "/pairs/hype.svg", name: "HYPE" },
  KNTQ: { src: "/tokens/kntq.png", name: "KNTQ", cls: " is-kntq" },
};
const pairBadge = (t: TokenStat) => PAIR_BADGES[(t.quote_symbol ?? "").toUpperCase()];

type ListMode = "verified" | "neuriio";

/** Explore's list (user, 2026-11-07): a Verified / Neuriio toggle. Each row: $TICKER with its market cap beside it, where it
 *  launched under it, and its 24h volume on the right. Picking a row opens it here. */
function TrendingList({
  mode,
  onMode,
  rows,
  error,
  picked,
  live,
  hypeUsd,
  onPick,
}: {
  mode: ListMode;
  onMode: (m: ListMode) => void;
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
        <span className="ex-list-toggle" role="tablist" aria-label="Which tokens">
          {(["verified", "neuriio"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={`ex-list-tab${mode === m ? " is-on" : ""}`} onClick={() => onMode(m)}>
              {m === "verified" ? "Verified" : "Neuriio"}
            </button>
          ))}
        </span>
        <span>24h vol</span>
      </div>
      <ol className="ex-list">
        {rows?.map((t, i) => (
          <li key={t.address}>
            <button className={`ex-row${picked?.address === t.address ? " is-picked" : ""}`} onClick={() => onPick(t)}>
              <span className="ex-rank">{i + 1}</span>
              <Avatar handle={t.handle} pfp={t.x_pfp_url} size={28} />
              <span className="ex-row-names">
                <span className="ex-row-handle ex-row-top" title={displayName(t)}>
                  <span className="ex-row-ticker-main">${t.symbol.replace(/^\$/, "")}</span>
                  <span className="ex-row-mcap-inline">{hypeUsd ? compactUsd((live[t.address] ?? t.price_hype) * 1e9 * hypeUsd) : "…"}</span>
                </span>
                <span className="ex-row-sub">
                  <VenueChip t={t} />
                </span>
              </span>
              <span className="ex-row-right">
                <span className="ex-row-mcap">{compactUsd(t.volume_usd_24h)}</span>
              </span>
            </button>
          </li>
        ))}
        {rows && rows.length === 0 && (
          <li className="ex-empty">{mode === "neuriio" ? "No tokens launched on Neuriio yet." : "No trades in the last 24 hours."}</li>
        )}
        {!rows && !error && <li className="ex-empty">Loading…</li>}
        {error && <li className="ex-empty">Couldn't load tokens.</li>}
      </ol>
    </>
  );
}

/** Lifetime creator fees this token has earned on Ascend (lib/fees: the indexer's creator_fees, no RPC calls), for our launches
 *  and Ascend's top tokens alike. undefined while loading; null when the indexer doesn't track it. */
function useCreatorEarned(t: TokenStat) {
  const [earned, setEarned] = useState<CreatorFees | null | undefined>(undefined);
  useEffect(() => {
    if (DEMO) return setEarned({ usd: t.volume_usd * 0.01 * 0.1, heldShare: 0 }); // demo: 10% of a 1% fee
    let alive = true;
    setEarned(undefined);
    const load = () => creatorFees(t.address).then((f) => alive && setEarned(f));
    const stop = poll(load, 5 * 60_000); // the indexer refreshes it every 5 minutes
    return () => {
      alive = false;
      stop();
    };
  }, [t.address, t.volume_usd]);
  return earned;
}

/** "$6.9K", "…" while loading, "N/A" when not tracked; the tooltip says how much is held back. */
function EarnedValue({ earned }: { earned: CreatorFees | null | undefined }) {
  if (earned === undefined) return <span className="ex-earned-value">…</span>;
  if (earned === null) return <span className="ex-earned-elsewhere" title="Not tracked yet">N/A</span>;
  const held = earned.heldShare > 0.005 ? ` ${Math.round(earned.heldShare * 100)}% of it is held by Ascend until the token holds a $40k market cap, and lost if it doesn't within 14 days.` : "";
  return <span className="ex-earned-value" title={`Paid to the creator by Ascend, lifetime.${held}`}>{compactUsd(earned.usd)}</span>;
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
  const [interval, setInterval_] = useState<IntervalSeconds>(1800); // 30m on load and on every token picked (user, 2026-11-07); this view remounts per token
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
    const load = () => candles(t.address, interval, 300).then((c) => alive && setData(c), () => {});
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
        <span className="ex-avatar-wrap">
          <Avatar handle={t.handle} pfp={t.x_pfp_url} size={44} />
          {/* paired with HYPE: Hyperliquid's brand-kit mark on the picture's bottom-left corner (user, 2026-11-07) */}
          {!isOurs(t) && pairBadge(t) && (
            <img className={`ex-pair-badge${pairBadge(t)!.cls ?? ""}`} src={pairBadge(t)!.src} alt={`${pairBadge(t)!.name} pair`} title={`Paired with ${pairBadge(t)!.name}`} />
          )}
        </span>
        <div className="ex-head-names">
          <span className="ex-handle">{displayName(t)}</span>
          <span className="ex-row-sub">
            <span className="ex-ticker">{tickerOf(t.symbol)}</span>
            <VenueChip t={t} />
          </span>
        </div>
        <span className="ex-chips">
          {sector && <span className="lp-chip ex-sector-chip">{sector}</span>}
          {isOurs(t) ? (
            <span className={`lp-chip${t.kind === "ftf" ? " ex-ftf-chip" : ""}`}>{t.kind === "ftf" ? "FTF" : cat}</span>
          ) : pairBadge(t) ? null : ( // HYPE and KNTQ pairs: their logo sits on the picture instead
            <span className="lp-chip">{t.quote_symbol ?? "USDC"} pair</span>
          )}
        </span>
        {!compact && (
          <>
            {/* tokens launched elsewhere get no button here: we don't send people off to other sites (user, 2026-11-06) */}
            {isOurs(t) && (
              <button className="ex-profile-btn" onClick={() => setShowProfile(true)}>
                <UserRound size={13} aria-hidden /> Profile
              </button>
            )}
            {isOurs(t) && <TokenArtButton t={t} />}
            <span className="ex-earned" title="Lifetime creator fees paid by Ascend">
              <span className="ex-earned-label">Creator fees earned</span>
              <EarnedValue earned={earned} />
            </span>
            {!isOurs(t) && <TokenLinks t={t} />}
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
        <div><dt>All-time volume</dt><dd>{compactUsd(t.volume_usd)}</dd></div>
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
  // big moves read short: +80.2K% rather than +80225.0%
  const text = Math.abs(c) >= 1000 ? `${(c / 1000).toFixed(1)}K%` : `${c.toFixed(1)}%`;
  return <span className={`ex-change ${c >= 0 ? "price-up" : "price-down"}`}>{`${c >= 0 ? "+" : ""}${text}`}</span>;
}

/** Where a token launched, as a small chip: Neuriio with our logo, else Ascend's. */
export function VenueChip({ t }: { t: TokenStat }) {
  if (isOurs(t))
    return (
      <span className="ex-venue is-ours" title="Launched on Neuriio">
        <img src="/brand/logo.png" alt="" />
        Neuriio
      </span>
    );
  return (
    <span className="ex-venue" title="Launched on Ascend, not on Neuriio">
      <img src="/launchpads/ascend.png" alt="" />
      Ascend
    </span>
  );
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

/** A token launched elsewhere: the X / website / Telegram links its creator set on Ascend (copied by our indexer; https only),
 *  as small icon links next to Creator fees (user, 2026-11-07). Nothing shows when it has none. */
function TokenLinks({ t }: { t: TokenStat }) {
  const [links, setLinks] = useState<Links | null>(null);
  useEffect(() => {
    let alive = true;
    setLinks(null);
    tokenLinks(t.address).then((x) => alive && setLinks(x), () => {});
    return () => {
      alive = false;
    };
  }, [t.address]);
  if (!links || (!links.x && !links.website && !links.telegram)) return null;
  return (
    <span className="ex-token-links">
      {links.x && (
        <a href={links.x} target="_blank" rel="noopener noreferrer" aria-label="X" title={links.x.replace(/^https:\/\/(www\.)?/, "")}>
          <img src="/social/x.svg" alt="" className="ex-token-link-x" />
        </a>
      )}
      {links.website && (
        <a href={links.website} target="_blank" rel="noopener noreferrer" aria-label="Website" title={links.website.replace(/^https:\/\/(www\.)?/, "")}>
          <Globe size={13} aria-hidden />
        </a>
      )}
      {links.telegram && (
        <a href={links.telegram} target="_blank" rel="noopener noreferrer" aria-label="Telegram" title={links.telegram.replace(/^https:\/\/(www\.)?/, "")}>
          <Send size={13} aria-hidden />
        </a>
      )}
    </span>
  );
}
