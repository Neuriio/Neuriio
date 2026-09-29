// Explore, under the chart (same width): the logged-in wallet's open positions in launched tokens, one line each:
// amount held, average entry and current market cap, value, and P/L (average-cost, from the wallet's trades).
// Clicking a row opens that token. `?demo`: three example positions.
import { useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { DEMO, type Position, positions } from "../lib/explore";
import { compactUsd } from "../lib/format";

export function PositionsCard({ hypeUsd, onPick }: { hypeUsd: number; onPick: (address: string) => void }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy")?.address;
  const loggedIn = DEMO || (ready && authenticated && !!wallet);
  const [rows, setRows] = useState<Position[] | null>(null);

  useEffect(() => {
    if (!loggedIn) return setRows(null);
    let alive = true;
    const load = () => positions(wallet ?? "").then((p) => alive && setRows(p), () => {});
    load();
    const id = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [loggedIn, wallet]);

  return (
    <div className="ex-positions">
      <div className="ex-tabs">
        <span className="ex-tab is-on">
          Positions{rows && rows.length > 0 ? <span className="ex-tab-count">{rows.length}</span> : null}
        </span>
      </div>

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
              const value = p.amount * t.price_hype * hypeUsd;
              const entryMc = (p.costUsd / p.amount) * 1e9;
              const nowMc = t.price_hype * 1e9 * hypeUsd;
              const pnl = value - p.costUsd;
              const pct = p.costUsd > 0 ? (pnl / p.costUsd) * 100 : 0;
              const cls = pnl >= 0 ? "price-up" : "price-down";
              return (
                <tr key={t.address} onClick={() => onPick(t.address)}>
                  <td>
                    <span className="ex-pos-token">
                      <span className="ex-avatar" style={{ width: 24, height: 24 }}>
                        {t.x_pfp_url ? <img src={t.x_pfp_url} alt="" referrerPolicy="no-referrer" /> : <span>{t.handle[0]?.toUpperCase()}</span>}
                      </span>
                      @{t.handle}
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
