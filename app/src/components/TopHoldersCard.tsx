// Explore, under the order box (user, 2026-11-08): the coin's top 10 holders by % of supply, refreshed every 5 minutes. It took the
// Launch check's place; the Launch check (LaunchCheckCard, its service and table) is kept, just not shown.
import { useEffect, useState } from "react";
import { elysiumTestnet } from "../chain";
import { shortAddress } from "../lib/format";
import { topHolders, type Holder } from "../lib/holders";
import { poll } from "../lib/poll";

const pct = (n: number) => (n >= 10 ? n.toFixed(1) : n >= 0.01 ? n.toFixed(2) : "<0.01") + "%";

export function TopHoldersCard({ address, creator }: { address: string; creator?: string | null }) {
  const [rows, setRows] = useState<Holder[] | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setRows(undefined);
    const stop = poll(() => topHolders(address, creator).then((r) => alive && setRows(r), () => alive && setRows(null)), 300_000);
    return () => {
      alive = false;
      stop();
    };
  }, [address, creator]);

  return (
    <div className="ex-bars-card ex-check">
      <div className="ex-bars-head">
        <span>Top holders</span>
      </div>
      {rows === undefined ? (
        <p className="ex-check-note">…</p>
      ) : rows === null ? (
        <p className="ex-check-note">Not counted yet. Holders update every 5 minutes.</p>
      ) : (
        <>
          <ul className="ex-check-list ex-holders">
            {rows.map((h, i) => (
              <li key={h.address}>
                <span className="ex-holder-rank">{i + 1}</span>
                <a href={`${elysiumTestnet.blockExplorers.default.url}/address/${h.address}`} target="_blank" rel="noreferrer">
                  {shortAddress(h.address)}
                </a>
                <span className="ex-check-why">{h.label ?? ""}</span>
                <b>{pct(h.pct)}</b>
              </li>
            ))}
          </ul>
          <p className="ex-check-note">Our own count from the chain. Updates every 5 minutes.</p>
        </>
      )}
    </div>
  );
}
