// The site footer on every app page (user, 2026-11-06, like Agora's): a thin bar along the bottom.
// Left: "Live", the top 15 Elysium tokens' pictures overlapped (Agora's list, as in Explore), "Top 15 Tokens by Volume on
// Elysium" and the latest Elysium block. Right: Docs, our X and the HYPE price. Block and price come with the same Agora
// answer as Explore's list (lib/agora.ts), refreshed every 20 s: no extra RPC calls. Phones keep Live, the pictures, the block
// and the price.
import { useEffect, useState } from "react";
import { BookOpen, Box } from "lucide-react";
import { agoraSnapshot, type AgoraSnapshot } from "../lib/agora";
import { displayName } from "../lib/explore";
import { poll } from "../lib/poll";
import { Avatar } from "./Avatar";

const DOCS = "https://docs.neuriio.xyz";
const X = { handle: "Neuriio", href: "https://x.com/Neuriio" };

export function SiteFooter() {
  const [snap, setSnap] = useState<AgoraSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      agoraSnapshot().then(
        (s) => {
          if (!alive) return;
          setSnap(s);
          setFailed(false);
        },
        () => alive && setFailed(true),
      );
    const stop = poll(load, 20_000);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  return (
    <footer className="site-foot">
      <div className="site-foot-left">
        <span className={`site-foot-live${failed ? " is-off" : ""}`}>
          <span className="site-foot-dot" aria-hidden />
          {failed ? "Offline" : "Live"}
        </span>
        {snap && snap.tokens.length > 0 && (
          <a className="site-foot-stack" href="/explore" title={snap.tokens.map(displayName).join(", ")}>
            {snap.tokens.slice(0, 15).map((t) => (
              <Avatar key={t.address} handle={t.handle} pfp={t.x_pfp_url} size={16} className="site-foot-coin" />
            ))}
            <span className="site-foot-label">
              Top 15 Tokens by Volume on <b>Elysium</b>
            </span>
          </a>
        )}
        {snap?.head != null && (
          <span className="site-foot-item" title="The latest Elysium block">
            <Box size={12} aria-hidden />
            <span className="site-foot-hide-sm">Elysium block</span> <b>{snap.head.toLocaleString("en-US")}</b>
          </span>
        )}
      </div>
      <div className="site-foot-right">
        <a className="site-foot-item site-foot-hide-sm" href={DOCS} target="_blank" rel="noopener noreferrer">
          <BookOpen size={12} aria-hidden /> Docs
        </a>
        <a className="site-foot-item" href={X.href} target="_blank" rel="noopener noreferrer" aria-label={`Neuriio on X (@${X.handle})`}>
          <img src="/social/x.svg" alt="" className="site-foot-x" />
          <span className="site-foot-hide-sm">@{X.handle}</span>
        </a>
        {snap && (
          <span className="site-foot-item" title="HYPE price">
            <img src="/tickers/white/HYPE.svg" alt="" className="site-foot-hype" />
            HYPE <b>${snap.hypeUsd.toFixed(2)}</b>
          </span>
        )}
      </div>
    </footer>
  );
}
