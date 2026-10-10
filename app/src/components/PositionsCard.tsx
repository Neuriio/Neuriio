// Explore, under the chart (same width): the logged-in wallet's open positions in launched tokens, one line each:
// amount held, average entry and current market cap, value, and P/L (average cost). Instant: stored trades
// (Supabase, refreshed every 15 s) + this wallet's trades from the live feed that aren't stored yet, deduped by
// tx hash + log index; prices come from the live feed. Clicking a row opens that token. `?demo`: 3 examples.
import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import {
  aggregatePositions,
  DEMO,
  displayName,
  type Position,
  positions as demoPositionsList,
  type TokenStat,
  tokensByAddress,
  type WalletTrade,
  walletTrades,
} from "../lib/explore";
import { compactUsd } from "../lib/format";
import { tradeId, useLivePrices, useLiveTrades } from "../lib/live";
import { Avatar } from "./Avatar";

/** `bare`: no "Positions" title (the mobile tab card already names it). */
export function PositionsCard({ hypeUsd, onPick, bare = false }: { hypeUsd: number; onPick: (address: string) => void; bare?: boolean }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy")?.address?.toLowerCase();
  const loggedIn = DEMO || (ready && authenticated && !!wallet);
  const livePrices = useLivePrices();
  const liveTrades = useLiveTrades();

  const [stored, setStored] = useState<WalletTrade[] | null>(null);
  const [demoRows, setDemoRows] = useState<Position[] | null>(null);
  const [stats, setStats] = useState<Map<string, TokenStat>>(new Map());

  // this wallet's trades seen live and not stored yet
  const mineLive = useMemo(() => {
    if (!wallet || !stored) return [];
    const have = new Set(stored.map((t) => t.id));
    return liveTrades
      .filter((t) => t.trader?.toLowerCase() === wallet && !have.has(tradeId(t)))
      .map<WalletTrade>((t) => ({ id: tradeId(t), market: t.token.toLowerCase(), side: t.side, size: t.tokens, usd: t.hype * hypeUsd, ts: t.ts }));
  }, [liveTrades, stored, wallet, hypeUsd]);

  // stored trades: every 15 s, and a few seconds after each of this wallet's live trades (the indexer catching up)
  useEffect(() => {
    if (DEMO) {
      demoPositionsList().then(setDemoRows);
      return;
    }
    if (!loggedIn || !wallet) return setStored(null);
    let alive = true;
    const load = () => walletTrades(wallet).then((t) => alive && setStored(t), () => {});
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [loggedIn, wallet]);
  useEffect(() => {
    if (!mineLive.length || !wallet) return;
    const id = setTimeout(() => walletTrades(wallet).then(setStored, () => {}), 4_000);
    return () => clearTimeout(id);
  }, [mineLive.length, wallet]);

  const open = useMemo(() => (stored ? aggregatePositions([...stored, ...mineLive]) : null), [stored, mineLive]);

  // token details for every open position (fetched once per token)
  const markets = open ? [...open.keys()].sort().join(",") : "";
  useEffect(() => {
    const missing = markets ? markets.split(",").filter((m) => !stats.has(m)) : [];
    if (!missing.length) return;
    tokensByAddress(missing).then((m) => setStats((prev) => new Map([...prev, ...m])), () => {});
  }, [markets]);

  const rows: Position[] | null = DEMO
    ? demoRows
    : open
      ? [...open]
          .filter(([m]) => stats.has(m))
          .map(([m, a]) => ({ token: stats.get(m)!, amount: a.amount, costUsd: a.costUsd, realizedUsd: a.realizedUsd }))
      : null;

  return (
    <div className="ex-positions">
      {!bare && (
        <div className="ex-tabs">
          <span className="ex-tab is-on">
            Positions{rows && rows.length > 0 ? <span className="ex-tab-count">{rows.length}</span> : null}
          </span>
        </div>
      )}

      {!loggedIn ? (
        <p className="ex-empty">
          <button className="link-btn" onClick={login}>
            Log in
          </button>{" "}
          to see your positions.
        </p>
      ) : !rows ? (
        <p className="ex-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="ex-empty">No open positions yet. Buy a token to see it here.</p>
      ) : (
        <table className="ex-pos-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Amount</th>
              <th>Avg entry (MC)</th>
              <th>Current (MC)</th>
              <th>Value</th>
              <th>P/L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const t = p.token;
              const price = livePrices[t.address] ?? t.price_hype;
              const value = p.amount * price * hypeUsd;
              const entryMc = (p.costUsd / p.amount) * 1e9;
              const nowMc = price * 1e9 * hypeUsd;
              const pnl = value - p.costUsd;
              const pct = p.costUsd > 0 ? (pnl / p.costUsd) * 100 : 0;
              const cls = pnl >= 0 ? "price-up" : "price-down";
              return (
                <tr key={t.address} onClick={() => onPick(t.address)}>
                  <td>
                    <span className="ex-pos-token">
                      <Avatar handle={t.handle} pfp={t.x_pfp_url} size={24} />
                      {displayName(t)}
                    </span>
                  </td>
                  <td>{p.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                  <td>{hypeUsd ? compactUsd(entryMc) : "…"}</td>
                  <td>{hypeUsd ? compactUsd(nowMc) : "…"}</td>
                  <td>{hypeUsd ? compactUsd(value) : "…"}</td>
                  <td className={cls}>
                    {hypeUsd ? `${pnl >= 0 ? "+" : "-"}${compactUsd(Math.abs(pnl))} (${pnl >= 0 ? "+" : ""}${pct.toFixed(1)}%)` : "…"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
