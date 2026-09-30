// /feed — posts like X. Layout (user's wireframe, 2026-09-30): the top bar as everywhere, the Explore search above
// the card, then one wide card: a left column (you: picture, sector, category, creator fees · your wallet balances ·
// top 25 trending by 24h volume) beside the posts. Every post has Like, Comment (opens the thread in a window to
// read) and Send $ (a window: pick one of your Elysium tokens + amount, sent to the poster's wallet). Posts, likes
// and comments are samples for now (nothing stored); sample posts have no wallet, so Send can't complete on them.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatEther, type Address } from "viem";
import { Bell, Heart, MessageCircle, Search, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { NotificationsModal } from "./NotificationsModal";
import { SendModal, type SendTarget } from "./SendModal";
import { useNotifications } from "../lib/ftf";
import { EASE_OUT } from "../lib/motion";
import { amount, compactUsd, usd } from "../lib/format";
import { useHypeUsd } from "../lib/tickers";
import { useBalances } from "../lib/useBalances";
import type { Balances } from "../lib/balances";
import { profileOf, type Profile } from "../lib/profile";
import { tokenCreatorEarned } from "../lib/fees";
import { CATEGORIES, launchedTokenOf, SECTORS } from "../lib/launch";
import { change24h, DEMO, displayName, getToken, searchTokens, topTokens, type TokenStat } from "../lib/explore";

type Comment = { handle: string; name: string; text: string; at: number };
type Post = {
  id: string;
  handle: string;
  name: string;
  pfp: string | null;
  ticker: string | null; // their launched token, if any
  wallet: Address | null; // their Neuriio wallet (Send goes here); null on sample posts
  text: string;
  at: number; // ms
  likes: number;
  comments: Comment[];
};

const NOW = Date.now();
const TEST_POSTS: Post[] = [
  {
    id: "t1",
    handle: "kntqkid",
    name: "kntq kid",
    pfp: null,
    ticker: "KNTQKID",
    wallet: null,
    text: "Just tokenized my account on Neuriio. Launch was free, took about ten seconds. Come say hi 👋",
    at: NOW - 4 * 60_000,
    likes: 24,
    comments: [
      { handle: "wagmiwes", name: "wagmi wes", text: "Welcome in. What sector did you pick?", at: NOW - 3 * 60_000 },
      { handle: "kntqkid", name: "kntq kid", text: "Finance, trader. Obviously.", at: NOW - 2 * 60_000 },
      { handle: "mememonk", name: "meme monk", text: "gm gm", at: NOW - 60_000 },
    ],
  },
  {
    id: "t2",
    handle: "the_liquidator",
    name: "the liquidator",
    pfp: null,
    ticker: "THE_LIQUIDATOR",
    wallet: null,
    text: "Forming an FTF with three friends from the trading group. Four members, one ticker, fees split four ways. Who else is building one?",
    at: NOW - 52 * 60_000,
    likes: 81,
    comments: [
      { handle: "vaultvera", name: "vault vera", text: "Doing one with my research crew this week.", at: NOW - 40 * 60_000 },
      { handle: "chartwizard", name: "chart wizard", text: "What's the name going to be?", at: NOW - 31 * 60_000 },
    ],
  },
  {
    id: "t3",
    handle: "vaultvera",
    name: "vault vera",
    pfp: null,
    ticker: null,
    wallet: null,
    text: "Energy sector is quiet on here so far. Anyone working on grids or storage want to link up?",
    at: NOW - 3 * 3600_000,
    likes: 12,
    comments: [{ handle: "onchainoliver", name: "onchain oliver", text: "Storage side, DMs open.", at: NOW - 2 * 3600_000 }],
  },
];

function ago(ms: number) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const exploreHref = (t: TokenStat) => `/explore?t=${t.address}${DEMO ? "&demo" : ""}`;

export function FeedCard() {
  const hypeUsd = useHypeUsd();
  const [reading, setReading] = useState<Post | null>(null);
  const [sendTo, setSendTo] = useState<SendTarget | null>(null);
  return (
    <>
      <FeedSearch hypeUsd={hypeUsd} />
      <section className="panel ex-card feed-card" aria-label="Feed">
        <div className="feed-grid">
          <aside className="feed-side">
            <Me />
            <Trending />
          </aside>
          <ol className="feed-list">
            {TEST_POSTS.map((p) => (
              <PostRow
                key={p.id}
                p={p}
                onComments={() => setReading(p)}
                onSend={() => setSendTo({ handle: p.handle, name: p.name, pfp: p.pfp, wallet: p.wallet })}
              />
            ))}
          </ol>
        </div>
      </section>
      <CommentsModal post={reading} onClose={() => setReading(null)} />
      <SendModal target={sendTo} onClose={() => setSendTo(null)} />
    </>
  );
}

// ------------------------------------------------------------------ search (same as Explore; opens the token there)

function FeedSearch({ hypeUsd }: { hypeUsd: number }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TokenStat[] | null>(null);
  useEffect(() => {
    if (!query.trim()) return setResults(null);
    let alive = true;
    const id = setTimeout(() => searchTokens(query).then((r) => alive && setResults(r), () => {}), 200);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [query]);
  return (
    <div className="feed-search">
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
              <a className="ex-row" href={exploreHref(t)}>
                <span className="ex-rank" />
                <Avatar handle={t.handle} pfp={t.x_pfp_url} size={28} />
                <span className="ex-row-names">
                  <span className="ex-row-handle">{displayName(t)}</span>
                </span>
                <span className="ex-row-mcap">{hypeUsd ? compactUsd(t.price_hype * 1e9 * hypeUsd) : "…"}</span>
              </a>
            </li>
          ))}
          {results.length === 0 && <li className="ex-empty">No handle matches.</li>}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ left column: you, notifications, your wallet

const DEMO_ME: Profile = { name: "@neuriio_demo", avatar: null, initial: "N" };
const DEMO_BALANCES: Balances = {
  total: 1834.52,
  at: 0,
  elysium: {
    total: 552.02,
    tokens: [
      { symbol: "HYPE", amount: 0, usd: 0 },
      { symbol: "USDC", amount: 552.02, usd: 552.02 },
    ],
  },
  hypercore: {
    total: 1282.5,
    tokens: [
      { symbol: "HYPE", amount: 2.85, usd: 262.4 },
      { symbol: "USDC", amount: 1020.1, usd: 1020.1 },
    ],
  },
};

function Me() {
  const { ready, authenticated, user, login } = usePrivy();
  const { wallets } = useWallets();
  const address = (DEMO ? undefined : wallets.find((w) => w.walletClientType === "privy")?.address) as Address | undefined;
  const { balances } = useBalances(address);
  const hypeUsd = useHypeUsd();
  const [token, setToken] = useState<TokenStat | null | undefined>(undefined); // undefined = loading, null = none
  const [earned, setEarned] = useState<number | null>(null);

  useEffect(() => {
    if (DEMO) {
      topTokens("volume_usd_24h", 1).then(([t]) => {
        setToken(t ?? null);
        if (t) setEarned((t.volume_usd / 90) * 0.0075 * 0.8);
      });
      return;
    }
    if (!address) return;
    let alive = true;
    launchedTokenOf(address)
      .then(async (a) => {
        if (!a) return alive && setToken(null);
        const [t, w] = await Promise.all([getToken(a), tokenCreatorEarned(a)]);
        if (!alive) return;
        setToken(t);
        setEarned(Number(formatEther(w)));
      })
      .catch(() => alive && setToken(null));
    return () => {
      alive = false;
    };
  }, [address]);

  if (!DEMO && !(ready && authenticated)) {
    return (
      <>
        <div className="feed-side-box feed-me feed-locked">
          <p>Log in with X to post, like and send.</p>
          <button className="lock-login" onClick={login} disabled={!ready}>
            Login
          </button>
        </div>
        <div className="feed-side-box feed-wallet feed-locked">
          <span className="feed-side-title">Wallet</span>
          <p>Your balances show here once you log in.</p>
        </div>
      </>
    );
  }

  const me = DEMO ? DEMO_ME : profileOf(user);
  const b = DEMO ? DEMO_BALANCES : balances;
  const sector = SECTORS.find((x) => x.id === token?.sector)?.label;
  const cat = token ? (token.kind === "ftf" ? "FTF" : CATEGORIES.find((c) => c.id === token.category)?.label) : null;
  return (
    <>
      <div className="feed-side-box feed-me">
        <div className="feed-me-id">
          <Avatar handle={me.initial} pfp={me.avatar} size={44} />
          <div className="feed-me-names">
            <span className="feed-name">{me.name}</span>
            {token && <span className="feed-ticker">${token.symbol}</span>}
          </div>
        </div>
        {token ? (
          <>
            <div className="feed-me-chips">
              {sector && <span className="lp-chip ex-sector-chip">{sector}</span>}
              {cat && <span className={`lp-chip${token.kind === "ftf" ? " ex-ftf-chip" : ""}`}>{cat}</span>}
            </div>
            <div className="feed-me-fees" title="Lifetime creator fees: 80% of your token's trading fees, paid in HYPE">
              <span className="feed-side-title">Creator fees earned</span>
              <span className="feed-me-fees-value">
                {earned === null ? "…" : hypeUsd ? compactUsd(earned * hypeUsd) : `${earned.toFixed(4)} HYPE`}
                {earned !== null && <span className="feed-muted"> · {earned.toLocaleString("en-US", { maximumFractionDigits: 4 })} HYPE</span>}
              </span>
            </div>
          </>
        ) : token === null ? (
          <a className="link-btn feed-me-launch" href={`/launch${DEMO ? "?demo" : ""}`}>
            Tokenize your account →
          </a>
        ) : null}
      </div>

      <NoticesBox />

      <div className="feed-side-box feed-wallet">
        <header className="feed-side-head">
          <span className="feed-side-title">Wallet</span>
          <span>{b ? usd(b.total) : "…"}</span>
        </header>
        {(["elysium", "hypercore"] as const).map((venue) => (
          <div key={venue} className="feed-venue">
            <span className="feed-venue-name">{venue === "elysium" ? "Elysium" : "HyperCore"}</span>
            {b?.[venue].tokens
              .filter((t) => t.amount > 0)
              .map((t) => (
                <div className="feed-bal" key={t.symbol}>
                  <span>{t.symbol}</span>
                  <span className="feed-bal-amt">{amount(t.amount)}</span>
                  <span className="feed-muted">{usd(t.usd)}</span>
                </div>
              ))}
            {b && b[venue].tokens.every((t) => t.amount === 0) && <span className="feed-muted feed-bal-empty">No balance</span>}
          </div>
        ))}
      </div>
    </>
  );
}

/** Small notifications box under your profile: the newest two (FTF invites + requests for now); opens the full window. */
function NoticesBox() {
  const { items } = useNotifications();
  const [open, setOpen] = useState(false);
  return (
    <div className="feed-side-box feed-notices">
      <button className="feed-side-head feed-notices-head" onClick={() => setOpen(true)}>
        <span className="feed-side-title">
          <Bell size={11} /> Notifications
        </span>
        {items.length > 0 ? <span className="feed-notices-count">{items.length}</span> : <span className="feed-muted">View</span>}
      </button>
      {items.length === 0 ? (
        <span className="feed-muted feed-notices-empty">Nothing new.</span>
      ) : (
        items.slice(0, 2).map((n) => (
          <button key={`${n.kind}:${n.draftId}:${n.from.x_user_id}`} className="feed-notice" onClick={() => setOpen(true)}>
            <Avatar handle={n.from.x_handle ?? "?"} pfp={n.from.x_pfp_url ?? null} size={22} />
            <span className="feed-notice-text">
              <b>@{n.from.x_handle ?? "someone"}</b> {n.kind === "invite" ? "invited you to" : "asked to join"} <b>{n.name}</b>
            </span>
          </button>
        ))
      )}
      <NotificationsModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

// ------------------------------------------------------------------ left column: top 25 trending (24h volume)

function Trending() {
  const [top, setTop] = useState<TokenStat[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => topTokens("volume_usd_24h", 25).then((r) => alive && setTop(r), () => {});
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return (
    <div className="feed-side-box feed-trending">
      <header className="feed-side-head">
        <span className="feed-side-title">Top 25 trending</span>
        <span className="feed-muted">24h vol</span>
      </header>
      <ol className="feed-trend-list">
        {top?.map((t, i) => {
          const ch = change24h(t);
          return (
            <li key={t.address}>
              <a className="ex-row" href={exploreHref(t)}>
                <span className="ex-rank">{i + 1}</span>
                <Avatar handle={t.handle} pfp={t.x_pfp_url} size={26} />
                <span className="ex-row-names">
                  <span className="ex-row-handle">{displayName(t)}</span>
                  {ch == null ? (
                    <span className="ex-change">—</span>
                  ) : (
                    <span className={`ex-change ${ch >= 0 ? "price-up" : "price-down"}`}>{`${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`}</span>
                  )}
                </span>
                <span className="ex-row-mcap">{compactUsd(t.volume_usd_24h)}</span>
              </a>
            </li>
          );
        })}
        {top && top.length === 0 && <li className="ex-empty">Nothing trading yet.</li>}
        {!top && <li className="ex-empty">Loading…</li>}
      </ol>
    </div>
  );
}

// ------------------------------------------------------------------ posts

function PostRow({ p, onComments, onSend }: { p: Post; onComments: () => void; onSend: () => void }) {
  const [liked, setLiked] = useState(false);
  return (
    <li className="feed-post">
      <Avatar handle={p.handle} pfp={p.pfp} size={42} />
      <div className="feed-body">
        <PostHead p={p} />
        <p className="feed-text">{p.text}</p>
        <div className="feed-actions">
          <button className={`feed-act feed-like${liked ? " is-on" : ""}`} onClick={() => setLiked(!liked)} aria-pressed={liked}>
            <Heart size={15} fill={liked ? "currentColor" : "none"} /> {p.likes + (liked ? 1 : 0)}
          </button>
          <button className="feed-act" onClick={onComments}>
            <MessageCircle size={15} /> {p.comments.length}
          </button>
          <button className="feed-act feed-send" onClick={onSend}>
            Send <b>$</b>
          </button>
        </div>
      </div>
    </li>
  );
}

function PostHead({ p }: { p: Post }) {
  return (
    <header className="feed-meta">
      <span className="feed-name">{p.name}</span>
      <span className="feed-handle">@{p.handle}</span>
      {p.ticker && <span className="feed-ticker">${p.ticker}</span>}
      <span className="feed-dot">·</span>
      <time className="feed-time" dateTime={new Date(p.at).toISOString()}>
        {ago(p.at)}
      </time>
    </header>
  );
}

/** Comments: the post and its thread in a window over the blurred page (read only for now). */
function CommentsModal({ post, onClose }: { post: Post | null; onClose: () => void }) {
  useEffect(() => {
    if (!post) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [post, onClose]);
  return createPortal(
    <AnimatePresence>
      {post && (
        <motion.div
          className="nt-backdrop"
          data-morph-keep
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            className="nt-modal feed-thread"
            role="dialog"
            aria-modal="true"
            aria-label="Comments"
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
          >
            <header className="nt-head">
              <span className="nt-title">
                <MessageCircle size={15} /> Comments
              </span>
              <button className="ex-modal-close" onClick={onClose} aria-label="Close comments">
                <X size={16} />
              </button>
            </header>
            <div className="feed-thread-post">
              <Avatar handle={post.handle} pfp={post.pfp} size={38} />
              <div className="feed-body">
                <PostHead p={post} />
                <p className="feed-text">{post.text}</p>
              </div>
            </div>
            <ol className="feed-thread-list">
              {post.comments.map((c, i) => (
                <li key={i} className="feed-comment">
                  <Avatar handle={c.handle} pfp={null} size={30} />
                  <div className="feed-body">
                    <header className="feed-meta">
                      <span className="feed-name">{c.name}</span>
                      <span className="feed-handle">@{c.handle}</span>
                      <span className="feed-dot">·</span>
                      <span className="feed-time">{ago(c.at)}</span>
                    </header>
                    <p className="feed-text">{c.text}</p>
                  </div>
                </li>
              ))}
              {post.comments.length === 0 && <li className="nt-empty">No comments yet.</li>}
            </ol>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
