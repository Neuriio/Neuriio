// /trending — three lists of launched tokens, each one card like Explore's Top 25 (prices live, refreshed every 20 s):
//   Bonding             top 25 by total volume still on the bonding curve
//   Recently graduated  graduated tokens, newest graduation first
//   Trending            top 25 by volume over the last 3 days
// Desktop: three columns side by side, each scrolling inside its card. Phones: one card with the three as tabs.
// A row opens that token on /explore. The launch page's dot strands sit on both sides.
import { useEffect, useState } from "react";
import { useLivePrices } from "../lib/live";
import { compactUsd } from "../lib/format";
import { QUOTE } from "../lib/config";
import { useIsMobile } from "../lib/media";
import { bondingTokens, DEMO, displayName, recentlyGraduated, trendingTokens, type TokenStat } from "../lib/explore";
import { Avatar } from "./Avatar";
import { ago, Change } from "./ExploreCard";

type ListId = "bonding" | "graduated" | "trending";
const LISTS: { id: ListId; title: string; sub: string; empty: string; load: () => Promise<TokenStat[]> }[] = [
  { id: "bonding", title: "Bonding", sub: "top 25 · volume", empty: "No tokens on the curve right now.", load: () => bondingTokens() },
  { id: "graduated", title: "Recently graduated", sub: "newest first", empty: "No graduations yet.", load: () => recentlyGraduated() },
  { id: "trending", title: "Trending", sub: "top 25 · 3-day volume", empty: "No trades in the last 3 days.", load: () => trendingTokens(3) },
];

export function TrendingCard() {
  const mobile = useIsMobile();
  const [tab, setTab] = useState<ListId>("bonding");
  if (mobile) {
    const list = LISTS.find((l) => l.id === tab)!;
    return (
      <section className="panel ex-card tr-card">
        <CardBg />
        <div className="ex-mtabs tr-mtabs" role="tablist">
          {LISTS.map((l) => (
            <button key={l.id} role="tab" aria-selected={tab === l.id} className={`ex-mtab${tab === l.id ? " is-on" : ""}`} onClick={() => setTab(l.id)}>
              {l.id === "graduated" ? "Graduated" : l.title}
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
        <span>{list.id === "graduated" ? "GRADUATED" : "MCAP"}</span>
      </div>
      <ol className="ex-list tr-list">
        {rows?.map((t, i) => {
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
                  {list.id === "graduated" && t.graduated_at ? ago(t.graduated_at) : hypeUsd ? compactUsd(price * 1e9 * hypeUsd) : "…"}
                </span>
              </a>
            </li>
          );
        })}
        {rows && rows.length === 0 && <li className="ex-empty">{list.empty}</li>}
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
