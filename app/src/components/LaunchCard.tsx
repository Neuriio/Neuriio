// /launch — "Tokenize yourself". First a single Launch button (flickering dot square), then the center card: live token
// preview on the left, short steps on the right (type -> category -> profile -> launch; the button opens on Category). Launch = our backend signs a one-time pass for your X account, then your
// Neuriio wallet sends Launchpad.launch (with an optional first buy). Your token is always "@handle" / HANDLE.
// Tokens are memes: the copy says back / support / trade, never invest.
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Brush,
  Building2,
  ChartCandlestick,
  Check,
  ExternalLink,
  Flame,
  Hammer,
  Laugh,
  LoaderCircle,
  Lock,
  Megaphone,
  Microscope,
  Plus,
  Rocket,
  Upload,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { TokenArtPrompt } from "./TokenArtModal";
import { formatEther, formatUnits, type Address, type EIP1193Provider } from "viem";
import { confirmed, elysiumProvider, walletClientFor } from "../lib/tx";
import { elysiumTestnet } from "../chain";
import { amount } from "../lib/format";
import { profileOf } from "../lib/profile";
import {
  ABOUT_MAX,
  ABOUT_MIN,
  CATEGORIES,
  type CategoryId,
  type CurveParams,
  fetchCurveParams,
  approveFirstBuy,
  checkPassPad,
  LAUNCHPAD,
  launchArgs,
  launchBalances,
  ftfTokenOf,
  launchedTokenOf,
  launchFtfArgs,
  launchpadAbi,
  MAX_LINKS,
  requestLaunchPass, estimateFirstBuy } from "../lib/launch";
import { EASE_OUT } from "../lib/motion";
import { DEPLOYED, QUOTE, SUPABASE_URL } from "../lib/config";
import { fileToBase64, FTF_NAME_RE, FTF_TICKER_RE, ftfCall, type FtfPassResponse, type FtfView } from "../lib/ftf";
import { poll } from "../lib/poll";

// Dev-only previews with a sample profile and a simulated launch:
//   localhost:5173/launch?demo      logged in (intro shows "Launch")
//   localhost:5173/launch?demo=out  logged out (intro shows "Login")
const DEMO_PARAM = import.meta.env.DEV ? new URLSearchParams(location.search).get("demo") : null;
const DEMO = DEMO_PARAM !== null;
const DEMO_OUT = DEMO_PARAM === "out";

const ICONS: Record<CategoryId, typeof Flame> = {
  trader: ChartCandlestick,
  meme_trader: Flame,
  researcher: Microscope,
  influencer: Megaphone,
  builder: Hammer,
  creator: Brush,
  meme_account: Laugh,
  founders: Building2,
};
type Mode = "personal" | "ftf";
type StepId = "type" | "members" | "category" | "profile" | "launch";
const STEP_IDS: Record<Mode, StepId[]> = {
  personal: ["type", "category", "profile", "launch"],
  ftf: ["type", "members", "category", "profile", "launch"],
};
const STEP_LABEL: Record<StepId, string> = {
  type: "Type",
  members: "Members",
  category: "Category",
  profile: "Profile",
  launch: "Launch",
};
const FTF_SIZE = 4;
const X_LABEL = /^(x|twitter)$/i; // a personal token's X link is its account's: nothing else can call itself that
const STAGES = ["Checking your X account", "Launching on Elysium", "You're live"] as const;
const QUICK_BUYS = ["0", "10", "50", "100"]; // USDC
const compactTokens = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
const pctLabel = (p: number) => (p >= 1 ? p.toFixed(2) : p >= 0.01 ? p.toFixed(3) : "<0.01") + "%";
const TESTNET_PARAMS: CurveParams = { startPrice: 0, feeBps: 150 }; // until the chain answers (no estimate shown)

type Link = { label: string; url: string };
type Phase = { kind: "form" } | { kind: "launching"; stage: number } | { kind: "live"; token: Address | null } | { kind: "error"; message: string };

export function LaunchCard() {
  const { ready, authenticated, user, login, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy");
  const me = profileOf(user);
  const x = user?.twitter;
  const [started, setStarted] = useState(false);
  const [launchedToken, setLaunchedToken] = useState<Address | null>(null);
  const [demoIn, setDemoIn] = useState(!DEMO_OUT); // ?demo=out: "Login" flips to "Launch" without Privy
  const loggedIn = DEMO ? demoIn : ready && authenticated;

  // already launched -> straight to their live screen, no intro
  useEffect(() => {
    if (!DEMO && wallet?.address) launchedTokenOf(wallet.address as Address).then(setLaunchedToken).catch(() => {});
  }, [wallet?.address]);

  // logged out: Launch opens the login first, then carries straight on to the flow
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (pending && loggedIn) setStarted(true);
  }, [pending, loggedIn]);

  if (!started && !launchedToken) {
    // (someone who already launched personally skips this; the Type step offers them an FTF)
    return (
      <LaunchGo
        busy={!DEMO && !ready}
        closed={!DEMO && !DEPLOYED}
        onLaunch={() => {
          if (loggedIn) return setStarted(true);
          setPending(true);
          if (DEMO) setDemoIn(true);
          else login();
        }}
      />
    );
  }
  if (DEMO) return <LaunchView handle="neuriio" avatar={null} demo />;
  return (
    <LaunchView
      handle={(x?.username ?? me.name.replace("@", "")).toLowerCase()}
      avatar={me.avatar}
      address={wallet?.address as Address | undefined}
      getAccessToken={getAccessToken}
      getProvider={wallet ? () => elysiumProvider(wallet) : undefined}
    />
  );
}

type ViewProps = {
  handle: string;
  avatar: string | null;
  address?: Address;
  demo?: boolean;
  getAccessToken?: () => Promise<string | null>;
  getProvider?: () => Promise<EIP1193Provider>;
};

function LaunchView({ handle, avatar, address, demo, getAccessToken, getProvider }: ViewProps) {
  const reduce = useReducedMotion();
  // the Launch button opens on Category, as a personal token (user, 2026-10-17); Back reaches Type for an FTF
  const [mode, setMode] = useState<Mode | null>("personal");
  const [personalToken, setPersonalToken] = useState<Address | null>(null);
  const [step, setStep] = useState(1);
  // FTF being formed
  const [ftf, setFtf] = useState<FtfView>({ draft: null, members: [] });
  const [ftfName, setFtfName] = useState("");
  const [ftfTicker, setFtfTicker] = useState("");
  const [invites, setInvites] = useState(["", "", ""]);
  const [ftfBusy, setFtfBusy] = useState(false);
  const [ftfError, setFtfError] = useState<string | null>(null);
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [about, setAbout] = useState("");
  const xLink: Link = { label: "X", url: `https://x.com/${handle}` };
  const [links, setLinks] = useState<Link[]>([xLink]);
  const [firstBuy, setFirstBuy] = useState("0");
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [params, setParams] = useState<CurveParams>(TESTNET_PARAMS);
  const [balance, setBalance] = useState<{ usdc: number; gas: number } | null>(null);

  useEffect(() => {
    // retry until it answers (on the live site the first chain read can wait on the security session)
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      fetchCurveParams().then(
        (p) => alive && setParams(p),
        () => alive && (timer = setTimeout(load, 5_000)),
      );
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  // already launched personally? (one per X account and wallet) Then only an FTF is left to launch.
  useEffect(() => {
    if (!address) return;
    launchedTokenOf(address).then(setPersonalToken).catch(() => {});
  }, [address]);

  // already launched personally: only an FTF is left, so back to Type
  useEffect(() => {
    if (!personalToken) return;
    setMode((m) => (m === "personal" ? null : m));
    setStep((i) => (mode === "personal" ? 0 : i));
  }, [personalToken]);

  // a personal token's first link is always its X account, locked (user, 2026-11-01). An FTF has no one account, so its links stay open.
  useEffect(() => {
    if (mode === "personal" && links[0]?.url !== xLink.url) setLinks([xLink, ...links.filter((l) => l.url !== xLink.url)]);
  }, [mode]);

  const ids = STEP_IDS[mode ?? "personal"];
  const current = ids[step];

  // USDC + gas for the first buy: read again on reaching the Launch step and every 10 s on it, so USDC that arrives
  // while the page is open (the faucet button sits under this card) shows up without a reload
  useEffect(() => {
    if (!address) return;
    let alive = true;
    const load = () =>
      launchBalances(address)
        .then((b) => alive && setBalance({ usdc: Number(formatUnits(b.usdc, QUOTE.decimals)), gas: Number(formatEther(b.gas)) }))
        .catch(() => {});
    // off the Launch step: one read; on it, every 20 s while visible and right after this browser's own transactions
    const stop = poll(load, current === "launch" ? 20_000 : null, { onChain: current === "launch" });
    return () => {
      alive = false;
      stop();
    };
  }, [address, current]);
  const tokenFor = getAccessToken ?? (async () => null);
  const acceptedCount = ftf.members.filter((m) => m.status === "accepted").length;

  // FTF: pick up the one you're forming (resume), and keep member statuses fresh while on Members
  const loadFtf = async () => {
    const v = await ftfCall<FtfView>(tokenFor, "mine");
    setFtf(v);
    if (v.draft) {
      if (v.draft.category) setCategory(v.draft.category);
      if (v.draft.about) setAbout(v.draft.about);
      if (v.draft.links?.length) setLinks(v.draft.links);
    }
    return v;
  };
  useEffect(() => {
    if (mode !== "ftf") return;
    loadFtf().catch(() => {});
  }, [mode]);
  useEffect(() => {
    if (mode !== "ftf" || current !== "members" || !ftf.draft) return;
    return poll(() => loadFtf().catch(() => {}), 4_000, { now: false });
  }, [mode, current, ftf.draft?.id]);

  async function ftfDo(action: string, body: Record<string, unknown>) {
    setFtfBusy(true);
    setFtfError(null);
    try {
      const v = await ftfCall<FtfView>(tokenFor, action, body);
      setFtf(v);
      return v;
    } catch (e) {
      setFtfError((e as Error).message);
      throw e;
    } finally {
      setFtfBusy(false);
    }
  }

  /** Members step, before the draft exists: create it, then invite the 3 handles. */
  async function sendInvites() {
    try {
      const v = await ftfDo("create", { name: ftfName.trim(), ticker: ftfTicker.trim() });
      for (const h of invites.map((x) => x.trim().replace(/^@/, "")).filter(Boolean)) {
        await ftfDo("invite", { draftId: v.draft!.id, handle: h });
      }
    } catch {
      /* shown in ftfError */
    }
  }

  async function uploadPfp(file: File) {
    if (!ftf.draft) return;
    if (file.size > 512 * 1024) return setFtfError("Picture must be 512 KB or smaller");
    try {
      await ftfDo("pfp", { draftId: ftf.draft.id, contentType: file.type, base64: await fileToBase64(file) });
    } catch {
      /* shown */
    }
  }

  const buy = Number(firstBuy) || 0;
  // tickers read in lower case with no "$" (user, 2026-10-18); on-chain they're in caps
  const ticker = (mode === "ftf" ? ftf.draft?.ticker ?? ftfTicker.trim() : handle).toLowerCase() || "ticker";
  const cleanLinks = links.filter((l) => l.label.trim() && l.url.trim());
  const fakeX = (l: Link, i: number) => mode === "personal" && i > 0 && X_LABEL.test(l.label.trim());
  const linksOk = cleanLinks.every((l) => /^https:\/\/\S+\.\S+/.test(l.url.trim())) && !links.some(fakeX);
  const aboutLen = about.trim().length;
  const ftfTickerOk = FTF_TICKER_RE.test(ftfTicker.trim());
  const ftfNameOk = ftfName.trim().length > 0 && ftfName.trim().length <= 32 && FTF_NAME_RE.test(ftfName.trim());
  const inviteHandles = invites.map((x) => x.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
  const invitesOk = inviteHandles.length === FTF_SIZE - 1 && new Set(inviteHandles).size === inviteHandles.length
    && inviteHandles.every((h) => /^[a-z0-9_]{1,15}$/.test(h) && h !== handle.toLowerCase());
  const canNext = {
    type: mode !== null && !(mode === "personal" && personalToken),
    members: acceptedCount === FTF_SIZE,
    category: category !== null,
    profile: aboutLen >= ABOUT_MIN && aboutLen <= ABOUT_MAX && linksOk,
    launch: agreed && buy >= 0,
  }[current];
  const isFtf = mode === "ftf";
  const ftfTickerShown = (ftf.draft?.ticker ?? ftfTicker.trim()).toLowerCase() || "ticker";
  // the first buy is paid in USDC; gas in HYPE
  const noGas = balance !== null && balance.gas === 0 && !demo;
  const lowUsdc = balance !== null && balance.usdc < buy && !demo;
  const lowGas = noGas || lowUsdc;

  async function launch() {
    setPhase({ kind: "launching", stage: 0 });
    try {
      if (demo) {
        await sleep(1100);
        setPhase({ kind: "launching", stage: 1 });
        await sleep(1600);
        setPhase({ kind: "live", token: null });
        return;
      }
      if (isFtf) {
        const r = await ftfCall<FtfPassResponse>(tokenFor, "pass", { draftId: ftf.draft!.id });
        setPhase({ kind: "launching", stage: 1 });
        const provider = await getProvider!();
        checkPassPad(r.launchpad);
        const { args, quoteIn } = launchFtfArgs(r, buy, params);
        const nonce = await approveFirstBuy(provider, address!, quoteIn);
        const hash = await walletClientFor(provider, address!).writeContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "launchFtf", args, nonce });
        await confirmed(hash);
        fetch(`${SUPABASE_URL}/functions/v1/indexer`, { method: "POST" }).catch(() => {});
        setPhase({ kind: "live", token: await ftfTokenOf(r.pass.ticker) });
        return;
      }
      const token = await getAccessToken!();
      if (!token) throw new Error("Session expired, log in again");
      const pass = await requestLaunchPass(token, {
        category: category!,
        profile: { about: about.trim(), links: cleanLinks.map((l) => ({ label: l.label.trim(), url: l.url.trim() })) },
      });
      setPhase({ kind: "launching", stage: 1 });
      const provider = await getProvider!();
      checkPassPad(pass.launchpad);
      const { args, quoteIn } = launchArgs(pass, buy, params);
      const nonce = await approveFirstBuy(provider, address!, quoteIn);
      const hash = await walletClientFor(provider, address!).writeContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "launch", args, nonce });
      await confirmed(hash);
      // ask the indexer to run now (it's idempotent + run-locked) so Supabase has the token within seconds;
      // Explore shows it straight from the chain meanwhile
      fetch(`${SUPABASE_URL}/functions/v1/indexer`, { method: "POST" }).catch(() => {});
      setPhase({ kind: "live", token: await launchedTokenOf(address!) });
    } catch (e) {
      setPhase({ kind: "error", message: friendly((e as Error).message) });
    }
  }

  const slide = reduce ? {} : { initial: { opacity: 0, x: 14 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -14 } };

  return (
    <div className="panel card-slot launch-card launch-flow">
      <LaunchBg />
      <div className="launch-grid">
        {/* ---- left: live token preview ---- */}
        <aside className="lp-preview">
          <div className="lp-id">
            <div className="lp-avatar">
              {isFtf ? (
                ftf.draft?.pfpUrl ? <img src={ftf.draft.pfpUrl} alt="" /> : <Users size={20} />
              ) : avatar ? (
                <img src={avatar} alt="" />
              ) : (
                <span>{handle.charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div className="lp-names">
              <span className="lp-name">{isFtf ? ftf.draft?.name || ftfName.trim() || "Your FTF" : `@${handle}`}</span>
              <span className="lp-ticker">{isFtf ? ftfTickerShown : ticker}</span>
            </div>
          </div>
          {isFtf && (
            <div className="lp-members-mini" aria-label="Members">
              {Array.from({ length: FTF_SIZE }, (_, i) => {
                const m = ftf.members.filter((x) => x.status !== "declined")[i];
                const ok = m?.status === "accepted";
                return (
                  <span key={i} className={`lp-member-dot${ok ? " is-in" : m ? " is-pending" : ""}`} title={m?.x_handle ? `@${m.x_handle.toLowerCase()}` : "Open spot"}>
                    {m?.x_pfp_url ? <img src={m.x_pfp_url} alt="" referrerPolicy="no-referrer" /> : m?.x_handle ? m.x_handle[0].toUpperCase() : "+"}
                  </span>
                );
              })}
              <span className="lp-members-count">{acceptedCount}/{FTF_SIZE} in</span>
            </div>
          )}
          <div className={`lp-chip${category ? "" : " lp-chip-empty"}`}>{category ? CATEGORIES.find((c) => c.id === category)!.label : "Pick a category"}</div>
          <dl className="lp-stats">
            <div>
              <dt>Supply</dt>
              <dd>1B</dd>
            </div>
          </dl>
          <p className="lp-meme">No promise of value.</p>
        </aside>

        {/* ---- right: steps ---- */}
        <section className="lp-form">
          <header className="lp-steps">
            {ids.map((id, i) => {
              const s = STEP_LABEL[id];
              const done = i < step || phase.kind === "live";
              return (
                <button
                  key={id}
                  className={`lp-step${i === step && !done ? " is-current" : ""}${done ? " is-done" : ""}`}
                  onClick={() => i < step && phase.kind === "form" && setStep(i)}
                  disabled={i > step || phase.kind !== "form"}
                >
                  <span className="lp-step-n">{done ? <Check size={11} strokeWidth={3} /> : `0${i + 1}`}</span>
                  <span className="lp-step-label">{s}</span>
                  {i === step && phase.kind !== "live" && (
                    <motion.span layoutId="lp-step-bar" className="lp-step-bar" transition={{ duration: 0.35, ease: EASE_OUT }} />
                  )}
                </button>
              );
            })}
          </header>

          <div className="lp-body">
            <AnimatePresence mode="wait" initial={false}>
              {phase.kind === "form" && current === "type" && (
                <motion.div key="type" className="lp-pane" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  <p className="lp-q">What are you launching?</p>
                  <div className="lp-types">
                    <button
                      className={`lp-type${mode === "personal" ? " is-on" : ""}`}
                      onClick={() => !personalToken && setMode("personal")}
                      disabled={!!personalToken}
                    >
                      <UserRound size={20} strokeWidth={1.8} />
                      <span className="lp-cat-label">Personal</span>
                      <span className="lp-cat-hint">
                        {personalToken ? `You already launched @${handle}` : `Your own token: @${handle}`}
                      </span>
                      {personalToken && (
                        <a className="link-btn lp-type-link" href={`/explore?t=${personalToken}`} onClick={(e) => e.stopPropagation()}>
                          Open in Explore
                        </a>
                      )}
                    </button>
                    <button className={`lp-type${mode === "ftf" ? " is-on" : ""}`} onClick={() => setMode("ftf")}>
                      <Users size={20} strokeWidth={1.8} />
                      <span className="lp-cat-label">FTF</span>
                      <span className="lp-cat-hint">Friends Turned Fam: you + 3 others, one group ticker, fees split 4 ways</span>
                    </button>
                  </div>
                </motion.div>
              )}

              {phase.kind === "form" && current === "members" && (
                <motion.div key="members" className="lp-pane" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  {!ftf.draft ? (
                    <>
                      <div className="lp-ftf-id">
                        <label className="lp-field">
                          <span className="lp-label">FTF name</span>
                          <input className="lp-input" value={ftfName} maxLength={32} placeholder="Degen Den" onChange={(e) => setFtfName(e.target.value)} />
                        </label>
                        <label className="lp-field lp-ticker-field">
                          <span className="lp-label">Ticker</span>
                          <input
                            className="lp-input"
                            value={ftfTicker.toLowerCase()}
                            maxLength={10}
                            placeholder="den"
                            onChange={(e) => setFtfTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                          />
                        </label>
                      </div>
                      <div className="lp-field">
                        <span className="lp-label">
                          Invite 3 people <span className="lp-count">X handles</span>
                        </span>
                        <div className="lp-invites">
                          {invites.map((v, i) => (
                            <div key={i} className="lp-invite">
                              <span className="lp-at">@</span>
                              <input
                                className="lp-input"
                                value={v}
                                maxLength={16}
                                placeholder={`member ${i + 2}`}
                                onChange={(e) => setInvites(invites.map((x, j) => (j === i ? e.target.value.replace(/[^A-Za-z0-9_@]/g, "") : x)))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                      <p className="lp-est">
                        They get a notification to accept (not a transaction). Each needs to have logged into Neuriio once.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="lp-q">
                        {ftf.draft.name} <span className="lp-count">{ftf.draft.ticker.toLowerCase()}</span>
                      </p>
                      <ul className="lp-member-list">
                        {ftf.members.filter((m) => m.status !== "declined" || m.role === "member").map((m) => (
                          <li key={m.x_user_id} className={`lp-member is-${m.status}`}>
                            <span className="lp-member-av">
                              {m.x_pfp_url ? <img src={m.x_pfp_url} alt="" referrerPolicy="no-referrer" /> : (m.x_handle ?? "?")[0].toUpperCase()}
                            </span>
                            <span className="lp-member-name">
                              @{(m.x_handle ?? "unknown").toLowerCase()}
                              {m.role === "founder" && <span className="lp-count"> · you, founder</span>}
                            </span>
                            <span className="lp-member-status">
                              {m.status === "accepted" ? (
                                <>
                                  <Check size={12} strokeWidth={3} /> In
                                </>
                              ) : m.status === "invited" ? (
                                <>
                                  <LoaderCircle size={12} className="spin" /> Invited
                                </>
                              ) : m.status === "requested" ? (
                                "Asked to join"
                              ) : (
                                "Declined"
                              )}
                            </span>
                            {m.role !== "founder" && m.status !== "declined" && (
                              <button
                                className="icon-btn"
                                aria-label={`Remove @${m.x_handle?.toLowerCase()}`}
                                disabled={ftfBusy}
                                onClick={() => ftfDo("remove", { draftId: ftf.draft!.id, xUserId: m.x_user_id }).catch(() => {})}
                              >
                                <X size={13} />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                      {ftf.members.filter((m) => m.status !== "declined").length < FTF_SIZE && (
                        <InviteMore busy={ftfBusy} onInvite={(h) => ftfDo("invite", { draftId: ftf.draft!.id, handle: h }).catch(() => {})} />
                      )}
                      <p className="lp-est">
                        {acceptedCount === FTF_SIZE
                          ? "All 4 are in. Next: category, profile and picture."
                          : `${acceptedCount}/${FTF_SIZE} in. Waiting for everyone to accept from their notifications.`}
                      </p>
                    </>
                  )}
                  {ftfError && <p className="lp-warn">{ftfError}</p>}
                </motion.div>
              )}

              {phase.kind === "form" && current === "category" && (
                <motion.div key="category" className="lp-pane" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  <p className="lp-q">{isFtf ? "What best describes this FTF?" : "What best describes you?"}</p>
                  <div className="lp-cats">
                    {CATEGORIES.map((c) => {
                      const Icon = ICONS[c.id];
                      return (
                        <button key={c.id} className={`lp-cat${category === c.id ? " is-on" : ""}`} onClick={() => setCategory(c.id)}>
                          <Icon size={16} strokeWidth={1.8} />
                          <span className="lp-cat-label">{c.label}</span>
                          <span className="lp-cat-hint">{c.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {phase.kind === "form" && current === "profile" && (
                <motion.div key="s1" className="lp-pane" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  {isFtf && (
                    <div className="lp-field">
                      <span className="lp-label">
                        FTF picture <span className="lp-count">PNG or JPEG · up to 512 KB</span>
                      </span>
                      <label className="lp-pfp">
                        <span className="lp-pfp-preview">{ftf.draft?.pfpUrl ? <img src={ftf.draft.pfpUrl} alt="" /> : <Users size={18} />}</span>
                        <span className="link-btn">
                          <Upload size={12} /> {ftf.draft?.pfpUrl ? "Change picture" : "Upload picture"}
                        </span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg"
                          hidden
                          onChange={(e) => e.target.files?.[0] && uploadPfp(e.target.files[0])}
                        />
                      </label>
                      {ftfError && <p className="lp-warn">{ftfError}</p>}
                    </div>
                  )}
                  <label className="lp-field">
                    <span className="lp-label">
                      {isFtf ? "About this FTF" : "About you"}
                      <span className={`lp-count${aboutLen > 0 && (aboutLen < ABOUT_MIN || aboutLen > ABOUT_MAX) ? " is-bad" : ""}`}>
                        {aboutLen < ABOUT_MIN ? `${ABOUT_MIN - aboutLen} more to go` : `${aboutLen}/${ABOUT_MAX}`}
                      </span>
                    </span>
                    <textarea
                      value={about}
                      maxLength={ABOUT_MAX}
                      onChange={(e) => setAbout(e.target.value)}
                      placeholder={isFtf ? "Who you are together, what you do, why these 4." : "Who you are, what you do, what people can see you've done."}
                      rows={5}
                    />
                  </label>
                  <div className="lp-field">
                    <span className="lp-label">
                      Links to your work
                      <span className="lp-count">https only</span>
                    </span>
                    <div className="lp-links">
                      {links.map((l, i) => (!isFtf && i === 0 ? (
                        <div key="x" className="lp-link is-locked" title="Your X account, added automatically">
                          <input className="lp-link-label" value={l.label} readOnly tabIndex={-1} aria-label="Link label" />
                          <input className="lp-link-url" value={l.url} readOnly tabIndex={-1} aria-label="Your X account" />
                          <span className="lp-link-lock" aria-hidden>
                            <Lock size={13} />
                          </span>
                        </div>
                      ) : (
                        <div key={i} className="lp-link">
                          <input
                            className={`lp-link-label${fakeX(l, i) ? " is-bad" : ""}`}
                            value={l.label}
                            placeholder="Label"
                            maxLength={80}
                            onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                          />
                          <input
                            className={`lp-link-url${l.url && !/^https:\/\/\S+\.\S+/.test(l.url.trim()) ? " is-bad" : ""}`}
                            value={l.url}
                            placeholder="https://"
                            onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                          />
                          <button className="icon-btn" aria-label="Remove link" onClick={() => setLinks(links.filter((_, j) => j !== i))}>
                            <X size={13} />
                          </button>
                        </div>
                      )))}
                      {links.some(fakeX) && <p className="lp-warn">Your X link is added automatically, so use another label.</p>}
                      {links.length < MAX_LINKS && (
                        <button className="link-btn lp-add" onClick={() => setLinks([...links, { label: "", url: "" }])}>
                          <Plus size={12} /> Add link
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}

              {phase.kind === "form" && current === "launch" && (
                <motion.div key="s2" className="lp-pane" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  <div className="lp-field">
                    <span className="lp-label">
                      First buy <span className="lp-count">optional · be your own first backer</span>
                    </span>
                    <div className="lp-buy">
                      <input
                        inputMode="decimal"
                        value={firstBuy}
                        onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setFirstBuy(e.target.value)}
                      />
                      <span className="lp-buy-unit">USDC</span>
                    </div>
                    <div className="lp-quick">
                      {QUICK_BUYS.map((q) => (
                        <button key={q} className={`lp-quick-btn${firstBuy === q ? " is-on" : ""}`} onClick={() => setFirstBuy(q)}>
                          {q === "0" ? "None" : q}
                        </button>
                      ))}
                      {balance !== null && <span className="lp-balance">Balance {amount(balance.usdc)} USDC</span>}
                    </div>
                    <p className="lp-est">
                      {buy > 0 ? (
                        params.startPrice > 0 ? (
                          // the opening-price estimate (user, 2026-11-09: it wasn't shown); matches real early buys on mainnet
                          <>
                            About <b>{compactTokens(estimateFirstBuy(buy, params).tokens)} tokens</b> ·{" "}
                            <b>{pctLabel(estimateFirstBuy(buy, params).pctOfSupply)} of supply</b>, bought first in the same transaction as
                            your launch.
                          </>
                        ) : (
                          <>You buy first, at market, in the same transaction as your launch.</>
                        )
                      ) : (
                        <>Launch with no first buy. Anyone can be first.</>
                      )}
                    </p>
                    {noGas && <p className="lp-warn">Add a little HYPE for gas to your Neuriio wallet on Elysium first (Account → deposit address).</p>}
                    {!noGas && lowUsdc && <p className="lp-warn">Not enough USDC for this first buy.</p>}
                  </div>
                  <label className="lp-agree">
                    <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                    <span>
                      I understand {isFtf ? ticker : `@${handle}`} has no promise of value or promise any returns to anyone.
                    </span>
                  </label>
                </motion.div>
              )}

              {phase.kind === "launching" && (
                <motion.div key="launching" className="lp-pane lp-stages" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  {STAGES.map((s, i) => (
                    <div key={s} className={`lp-stage${i < phase.stage ? " is-done" : i === phase.stage ? " is-now" : ""}`}>
                      <span className="lp-stage-icon">
                        {i < phase.stage ? <Check size={13} strokeWidth={3} /> : i === phase.stage ? <LoaderCircle size={14} className="spin" /> : null}
                      </span>
                      {s}
                    </div>
                  ))}
                </motion.div>
              )}

              {phase.kind === "live" && (
                <motion.div
                  key="live"
                  className="lp-pane lp-live"
                  initial={reduce ? false : { opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: "spring", stiffness: 380, damping: 26 }}
                >
                  <Rocket size={22} className="lp-live-icon" />
                  <p className="lp-live-title">{isFtf ? `${ftf.draft?.name ?? "Your FTF"} (${ticker})` : `@${handle}`} is live</p>
                  <p className="lp-live-sub">Your token is trading now.</p>
                  <div className="lp-live-actions">
                    {/* last step: send their picture, bio and links to Ascend now (user, 2026-11-09) */}
                    {phase.token && !DEMO && <TokenArtPrompt token={phase.token} />}
                    <a
                      className="lock-login lp-cta"
                      target="_blank"
                      rel="noreferrer"
                      href={`https://x.com/intent/post?text=${encodeURIComponent(
                        isFtf ? `Our FTF ${ftf.draft?.name ?? ticker} is live on @Neuriio` : `I just tokenized my account: @${handle} is live on @Neuriio`,
                      )}`}
                    >
                      Share on X
                    </a>
                    <a className="link-btn" href={`/explore?t=${phase.token ?? handle}${DEMO ? "&demo" : ""}`}>
                      Open in Explore
                    </a>
                    {phase.token && (
                      <a className="link-btn" target="_blank" rel="noreferrer" href={`${elysiumTestnet.blockExplorers.default.url}/address/${phase.token}`}>
                        View token <ExternalLink size={11} />
                      </a>
                    )}
                  </div>
                </motion.div>
              )}

              {phase.kind === "error" && (
                <motion.div key="error" className="lp-pane lp-live" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  <p className="lp-live-title lp-error-title">Launch didn't go through</p>
                  <p className="lp-live-sub">{phase.message}</p>
                  <button className="lock-login lp-cta" onClick={() => setPhase({ kind: "form" })}>
                    Back to launch
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {phase.kind === "form" && (
            <footer className="lp-foot">
              <button
                className="link-btn lp-back"
                onClick={() => setStep(step - 1)}
                disabled={step === 0}
              >
                <ArrowLeft size={12} /> Back
              </button>
              {current === "members" && !ftf.draft ? (
                <button className="lock-login lp-cta" disabled={!ftfNameOk || !ftfTickerOk || !invitesOk || ftfBusy} onClick={sendInvites}>
                  {ftfBusy ? <LoaderCircle size={13} className="spin" /> : null} Send invites
                </button>
              ) : current !== "launch" ? (
                <button
                  className="lock-login lp-cta"
                  disabled={!canNext || ftfBusy}
                  onClick={async () => {
                    // FTF: save category + profile before the launch step (the pass is signed from what's saved)
                    if (isFtf && current === "profile") {
                      try {
                        await ftfDo("profile", {
                          draftId: ftf.draft!.id,
                          category,
                          about: about.trim(),
                          links: cleanLinks.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
                        });
                      } catch {
                        return;
                      }
                    }
                    setStep(step + 1);
                  }}
                >
                  Next <ArrowRight size={13} />
                </button>
              ) : (
                <button className="lock-login lp-cta lp-launch" disabled={!canNext || lowGas} onClick={launch}>
                  <Rocket size={13} /> Launch {isFtf ? ticker : `@${handle}`}
                </button>
              )}
            </footer>
          )}
        </section>
      </div>
    </div>
  );
}

/** The flow card's background: dot grid + two slow glows. */
function LaunchBg() {
  return (
    <div className="li-bg" aria-hidden>
      <span className="li-tint" />
      <span className="li-dots" />
      {TWINKLES.map((i) => (
        <Twinkle key={i} index={i} />
      ))}
    </div>
  );
}

const TWINKLES = Array.from({ length: 14 }, (_, i) => i);
const GRID = 20; // .li-dots spacing; dots sit at the center of each 20px tile

/** One grid dot that glows and fades, then jumps to another dot on the right side (where the grid shows). */
function Twinkle({ index }: { index: number }) {
  const [pos, setPos] = useState(randomDot);
  return (
    <span
      className="li-twinkle"
      style={{ left: pos.x, top: pos.y, animationDelay: `${(index * 0.31) % 4.2}s`, animationDuration: `${3.6 + (index % 5) * 0.35}s` }}
      onAnimationIteration={() => setPos(randomDot())}
    />
  );
}

function randomDot() {
  // where the dots are clearly visible: right ~45% of the card, below the faded top (card up to 1000 x 510)
  const c = 28 + Math.floor(Math.random() * 22);
  const r = 5 + Math.floor(Math.random() * 20);
  return { x: c * GRID + GRID / 2, y: r * GRID + GRID / 2 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function friendly(msg: string) {
  if (/already launched/i.test(msg)) return "You already launched your token. One per X account.";
  if (/insufficient funds/i.test(msg)) return "Not enough HYPE for gas.";
  if (/exceeds balance|InsufficientBalance/i.test(msg)) return "Not enough USDC for this first buy.";
  if (/rejected|denied/i.test(msg)) return "The transaction was cancelled.";
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

/** Members step: invite someone for an open spot (after a decline or a removal). */
function InviteMore({ busy, onInvite }: { busy: boolean; onInvite: (handle: string) => void }) {
  const [h, setH] = useState("");
  const clean = h.trim().replace(/^@/, "");
  return (
    <div className="lp-invite lp-invite-more">
      <span className="lp-at">@</span>
      <input className="lp-input" value={h} maxLength={16} placeholder="invite someone" onChange={(e) => setH(e.target.value.replace(/[^A-Za-z0-9_@]/g, ""))} />
      <button
        className="link-btn"
        disabled={busy || !/^[A-Za-z0-9_]{1,15}$/.test(clean)}
        onClick={() => {
          onInvite(clean);
          setH("");
        }}
      >
        <Plus size={12} /> Invite
      </button>
    </div>
  );
}

/**
 * /launch first screen (user, 2026-10-17): one big Launch button in the middle of the page, inside a small circle of
 * dots, with a band of dots ~3 rows tall running level with the button across the whole page. Every dot sits faintly
 * and slowly flickers on and off at random (in the circle, more often near the button). Launch opens the flow on the
 * Category step (logging in first if needed).
 */
function LaunchGo({ busy, closed, onLaunch }: { busy: boolean; closed: boolean; onLaunch: () => void }) {
  // closed: our launcher isn't on mainnet yet (deployments/elysium-mainnet.json "launcher" is null), so nothing can launch
  return (
    <div className="launch-go">
      <FlickerDots shape="band" />
      <FlickerDots shape="circle" />
      <button className={`launch-go-btn${closed ? " is-closed" : ""}`} onClick={onLaunch} disabled={busy || closed}>
        {closed ? "Launches open soon" : "Launch"}
      </button>
    </div>
  );
}

const DOT_SPACING = 15; // px between neighboring dots
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // sunflower spiral: dots fill the circle evenly, in no grid or rows
const BAND_ROWS = 3;

type Dot = { x: number; y: number; edge: number; start: number; life: number; cyan: boolean };

/** Faint dots that each slowly glow up and fade, then wait before the next time. "circle": a filled circle round the
 *  button (waits get longer toward the rim, so most flicker is near the button). "band": BAND_ROWS rows across the
 *  page, level with the button, skipping the circle's middle (the circle canvas is its height). */
function FlickerDots({ shape }: { shape: "circle" | "band" }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let w = 0;
    let h = 0;
    let raf = 0;
    let dots: Dot[] = [];
    const next = (d: Dot, now: number, first = false) => {
      d.life = 2600 + Math.random() * 3400;
      d.start = now + (first ? -Math.random() * 9000 : 600 + Math.random() * (2000 + d.edge * d.edge * 9000));
      d.cyan = Math.random() < 0.3;
    };
    const dot = (x: number, y: number, edge: number): Dot => ({ x, y, edge, start: 0, life: 0, cyan: false });
    const layout = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (shape === "circle") {
        const R = w / 2 - 4;
        const n = Math.floor((Math.PI * R * R) / (DOT_SPACING * DOT_SPACING));
        dots = Array.from({ length: n }, (_, i) => {
          const r = R * Math.sqrt((i + 0.5) / n);
          return dot(w / 2 + Math.cos(i * GOLDEN) * r, h / 2 + Math.sin(i * GOLDEN) * r, r / R);
        });
      } else {
        // the circle (same width as this canvas's height) covers the middle; the band runs out from its rim
        const hole = h / 2 + 2;
        dots = [];
        for (let row = 0; row < BAND_ROWS; row++)
          for (let x = DOT_SPACING / 2 + (row % 2) * (DOT_SPACING / 2); x < w; x += DOT_SPACING) {
            if (Math.abs(x - w / 2) < hole) continue;
            const jitter = () => (Math.random() - 0.5) * 4; // a touch loose, so it doesn't read as a ruled grid
            dots.push(dot(x + jitter(), h / 2 + (row - (BAND_ROWS - 1) / 2) * DOT_SPACING + jitter(), 0.4 + Math.random() * 0.6));
          }
      }
      const now = performance.now();
      for (const d of dots) next(d, now, true);
    };
    const draw = (now: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const d of dots) {
        if (now - d.start > d.life) next(d, now);
        const t = (now - d.start) / d.life;
        const glow = reduce || t < 0 ? 0 : Math.sin(Math.PI * t) ** 2;
        const color = glow > 0 && d.cyan ? "216, 255, 254" : "236, 221, 255";
        ctx.fillStyle = `rgba(${color}, ${0.13 + glow * 0.8})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, 1.2 + glow * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    layout();
    draw(performance.now());
    const ro = new ResizeObserver(() => {
      layout();
      if (reduce) draw(performance.now());
    });
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [reduce, shape]);
  return <canvas ref={ref} className={`launch-go-dots is-${shape}`} aria-hidden />;
}
