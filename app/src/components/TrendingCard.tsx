// /trending — three lists of launched tokens, each one card like Explore's Top 25 (prices live, refreshed every 20 s):
//   Early     top 25 by total volume under a $70k market cap
//   Matured   top 25 by total volume at $70k and up
//   Trending  top 25 by 24h volume
// Desktop: three columns side by side, each scrolling inside its card. Phones: one card with the three as tabs.
// A row opens that token on /explore. The launch page's dot strands sit on both sides.
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useLivePrices } from "../lib/live";
import { compactUsd } from "../lib/format";
import { QUOTE } from "../lib/config";
import { useIsMobile } from "../lib/media";
import { DEMO, displayName, EARLY_MAX_MCAP, earlyTokens, maturedTokens, trendingTokens, type TokenStat } from "../lib/explore";
import { Avatar } from "./Avatar";
import { Change } from "./ExploreCard";

type ListId = "early" | "matured" | "trending";
const LISTS: { id: ListId; title: string; sub: string; empty: string; load: () => Promise<TokenStat[]>; fits?: (mcap: number) => boolean }[] = [
  { id: "early", title: "Early", sub: "top 25 · volume", empty: "No tokens under a $70k market cap.", load: () => earlyTokens(), fits: (mcap) => mcap < EARLY_MAX_MCAP },
  { id: "matured", title: "Matured", sub: "top 25 · volume", empty: "No tokens at a $70k market cap or above.", load: () => maturedTokens(), fits: (mcap) => mcap >= EARLY_MAX_MCAP },
  { id: "trending", title: "Trending", sub: "top 25 · 24h volume", empty: "No trades in the last 24 hours.", load: () => trendingTokens() },
];

export function TrendingCard() {
  const mobile = useIsMobile();
  const [tab, setTab] = useState<ListId>("early");
  if (mobile) {
    const list = LISTS.find((l) => l.id === tab)!;
    return (
      <section className="panel ex-card tr-card">
        <CardBg />
        <div className="ex-mtabs tr-mtabs" role="tablist">
          {LISTS.map((l) => (
            <button key={l.id} role="tab" aria-selected={tab === l.id} className={`ex-mtab${tab === l.id ? " is-on" : ""}`} onClick={() => setTab(l.id)}>
              {l.title}
            </button>
          ))}
        </div>
        <TokenList key={list.id} list={list} />
      </section>
    );
  }
  return (
    <div className="tr-grid">
      {LISTS.map((l) => (
        <section key={l.id} className="panel ex-card tr-card tr-col">
          <CardBg />
          <TokenList list={l} />
        </section>
      ))}
    </div>
  );
}

function TokenList({ list }: { list: (typeof LISTS)[number] }) {
  const hypeUsd = QUOTE.usd; // launched tokens are priced in USDC
  const live = useLivePrices();
  const [rows, setRows] = useState<TokenStat[] | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<"desc" | "asc" | null>(null); // MCAP arrow: highest first, lowest first, or the list's own order

  // a live price can cross the $70k line between refreshes: the row leaves right away, and joins the other list at the next one
  const mcapOf = (t: TokenStat) => (live[t.address] ?? t.price_hype) * 1e9 * hypeUsd;
  const shown = rows?.filter((t) => list.fits?.(mcapOf(t)) ?? true) ?? null;

  useEffect(() => {
    let alive = true;
    const load = () =>
      list.load().then(
        (r) => {
          if (!alive) return;
          setRows(r);
          setError(false);
        },
        () => alive && setError(true),
      );
    load();
    const id = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [list]);

  return (
    <>
      <div className="ex-list-head">
        <span>
          <span className="tr-title">{list.title}</span> · {list.sub}
        </span>
        <button
          className={`tr-sort${sort ? " is-on" : ""}`}
          onClick={() => setSort(sort === null ? "desc" : sort === "desc" ? "asc" : null)}
          title={sort === "desc" ? "Highest market cap first" : sort === "asc" ? "Lowest market cap first" : "Sort by market cap"}
        >
          MCAP {sort === "desc" ? <ArrowDown size={11} /> : sort === "asc" ? <ArrowUp size={11} /> : <ArrowUpDown size={11} />}
        </button>
      </div>
      <ol className="ex-list tr-list">
        {(sort && shown ? [...shown].sort((a, b) => ((live[a.address] ?? a.price_hype) - (live[b.address] ?? b.price_hype)) * (sort === "asc" ? 1 : -1)) : shown)?.map((t, i) => {
          const price = live[t.address] ?? t.price_hype;
          return (
            <li key={t.address}>
              <a className="ex-row" href={`/explore?t=${t.address}${DEMO ? "&demo" : ""}`}>
                <span className="ex-rank">{i + 1}</span>
                <Avatar handle={t.handle} pfp={t.x_pfp_url} size={28} />
                <span className="ex-row-names">
                  <span className="ex-row-handle">{displayName(t)}</span>
                  <Change t={t} price={live[t.address]} />
                </span>
                <span className="ex-row-mcap">
                  {hypeUsd ? compactUsd(price * 1e9 * hypeUsd) : "…"}
                </span>
              </a>
            </li>
          );
        })}
        {shown && shown.length === 0 && <li className="ex-empty">{list.empty}</li>}
        {!rows && !error && <li className="ex-empty">Loading…</li>}
        {error && <li className="ex-empty">Couldn't load tokens.</li>}
      </ol>
      {rows && <p className="ex-list-foot">Live prices · list refreshed every 20 s</p>}
    </>
  );
}

/** The /launch cards' background: lavender tint + dot grid. */
function CardBg() {
  return (
    <div className="li-bg ex-bg-top" aria-hidden>
      <span className="li-tint" />
      <span className="li-dots" />
    </div>
  );
}
