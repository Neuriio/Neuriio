// Explore, under the order box: who bought this token right after it launched and which of them are tied together (lib/launchCheck.ts).
// Careful wording on purpose: timing alone is "fast buyers", "linked" means real on-chain evidence, and finding nothing never says "safe".
import { useEffect, useState } from "react";
import { elysiumTestnet } from "../chain";
import { DEMO } from "../lib/explore";
import { shortAddress } from "../lib/format";
import { demoLaunchCheck, launchCheck, REASON_LABEL, type LaunchCheck } from "../lib/launchCheck";

const pct = (n: number) => `${n >= 10 ? n.toFixed(1) : n.toFixed(2).replace(/\.?0+$/, "") || "0"}%`;
const wallets = (n: number) => `${n} wallet${n === 1 ? "" : "s"}`;

const HEADLINE: Record<LaunchCheck["status"], string> = {
  linked: "Linked wallets found",
  fast: "Fast buyers, no links found",
  none: "No early buyers",
};

export function LaunchCheckCard({ address }: { address: string }) {
  const [check, setCheck] = useState<LaunchCheck | null | undefined>(undefined);
  useEffect(() => {
    if (DEMO) return setCheck(demoLaunchCheck(address));
    let alive = true;
    const load = () => launchCheck(address).then((c) => alive && setCheck(c), () => alive && setCheck(null));
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [address]);

  return (
    <div className={`ex-bars-card ex-check${check?.status === "linked" ? " is-linked" : ""}`}>
      <div className="ex-bars-head">
        <span>Launch check</span>
      </div>
      {check === undefined ? (
        <p className="ex-check-note">…</p>
      ) : check === null ? (
        <p className="ex-check-note">Not checked yet. It runs about a minute after the first buy.</p>
      ) : (
        <>
          <p className="ex-check-headline">{HEADLINE[check.status]}</p>
          <dl className="ex-check-stats">
            {check.status !== "none" && (
              <div>
                <dt>Bought in first {check.window_seconds}s</dt>
                <dd>
                  {pct(check.early_pct)} <span>{wallets(check.early_wallets)}</span>
                </dd>
              </div>
            )}
            {check.status === "linked" && (
              <div className="is-alert">
                <dt>Linked</dt>
                <dd>
                  {pct(check.linked_pct)} <span>{wallets(check.linked_wallets)}</span>
                </dd>
              </div>
            )}
            {check.status !== "none" && (
              <div>
                <dt>{check.status === "linked" ? "Linked still hold" : "Still held"}</dt>
                <dd>{pct(check.held_pct)}</dd>
              </div>
            )}
            {check.creator_pct > 0 && (
              <div>
                <dt>Creator's first buy</dt>
                <dd>{pct(check.creator_pct)}</dd>
              </div>
            )}
          </dl>
          {check.wallets.some((w) => w.group !== null || !w.creator) && (
            <ul className="ex-check-list">
              {check.wallets
                .filter((w) => w.group !== null || !w.creator)
                .map((w) => (
                  <li key={w.address}>
                    <a href={`${elysiumTestnet.blockExplorers.default.url}/address/${w.address}`} target="_blank" rel="noreferrer">
                      {shortAddress(w.address)}
                    </a>
                    <span className="ex-check-why">{w.creator ? "Creator · " : ""}{w.reasons.map((r) => REASON_LABEL[r]).join(", ") || "Early buy"}</span>
                    <b>{pct(w.pct)}</b>
                  </li>
                ))}
            </ul>
          )}
          <p className="ex-check-note">Public chain data. Can miss links or flag unrelated wallets.</p>
        </>
      )}
    </div>
  );
}
