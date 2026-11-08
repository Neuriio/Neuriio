// The site footer on every app page (user, 2026-11-06): a thin bar along the bottom.
// Left: "Live", Ascend's top 15 tokens' pictures overlapped (the same list as Explore's Verified), "Top 15 by Volume on
// Elysium" and the latest Elysium block. Right: Docs, our X and the HYPE price. All from our own data (user, 2026-11-07: no
// Agora): the list and the block from our indexer (Supabase, every 20 s; "Live" while the indexer read the chain in the last
// 3 minutes), the price from Hyperliquid. No RPC calls. Phones keep Live, the pictures, the block and the price.
import { useEffect, useState } from "react";
import { BookOpen, Box } from "lucide-react";
import { displayName, indexedHead, type TokenStat, verifiedTokens } from "../lib/explore";
import { useHypeUsd } from "../lib/tickers";
import { poll } from "../lib/poll";
import { Avatar } from "./Avatar";

const DOCS = "https://docs.neuriio.xyz";
const X = { handle: "Neuriio", href: "https://x.com/Neuriio" };

export function SiteFooter() {
  const [snap, setSnap] = useState<{ tokens: TokenStat[]; head: number | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const hypeUsd = useHypeUsd(20_000);
  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([verifiedTokens(15), indexedHead()]).then(
        ([tokens, head]) => {
          if (!alive) return;
          setSnap({ tokens, head: head?.block ?? null });
          setFailed(!head || Date.now() - head.at > 3 * 60_000);
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
              Top 15 by Volume on <b>Elysium</b>
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
        {hypeUsd > 0 && (
          <span className="site-foot-item" title="HYPE price">
            <img src="/tickers/white/HYPE.svg" alt="" className="site-foot-hype" />
            HYPE <b>${hypeUsd.toFixed(2)}</b>
          </span>
        )}
      </div>
    </footer>
  );
}
