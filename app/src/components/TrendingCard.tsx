// /trending — the Top 25 by total volume (re-ranked every minute by the database; prices live), one card between
// the launch page's dot strands. A row opens that token on /explore. Built phone-first (2026-10-10).
import { useEffect, useState } from "react";
import { useLivePrices } from "../lib/live";
import { compactUsd } from "../lib/format";
import { useHypeUsd } from "../lib/tickers";
import { DEMO, displayName, topByTotalVolume, type TokenStat } from "../lib/explore";
import { Avatar } from "./Avatar";
import { ago, Change } from "./ExploreCard";

export function TrendingCard() {
  const hypeUsd = useHypeUsd();
  const live = useLivePrices();
  const [top, setTop] = useState<TokenStat[] | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      topByTotalVolume().then(
        ({ tokens, snapshotAt: at }) => {
          if (!alive) return;
          setTop(tokens);
          setSnapshotAt(at);
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
  }, []);

  return (
    <section className="panel ex-card tr-card">
      <div className="li-bg ex-bg-top" aria-hidden>
        <span className="li-tint" />
        <span className="li-dots" />
      </div>
      <div className="ex-list-head">
        <span>Top 25 · total volume</span>
        <span>MCAP</span>
      </div>
      <ol className="ex-list tr-list">
        {top?.map((t, i) => {
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
                <span className="ex-row-mcap">{hypeUsd ? compactUsd(price * 1e9 * hypeUsd) : "…"}</span>
              </a>
            </li>
          );
        })}
        {top && top.length === 0 && <li className="ex-empty">No tokens traded yet.</li>}
        {!top && !error && <li className="ex-empty">Loading…</li>}
        {error && <li className="ex-empty">Couldn't load tokens.</li>}
      </ol>
      {snapshotAt && <p className="ex-list-foot">Ranked {ago(snapshotAt)} · every minute</p>}
    </section>
  );
}
