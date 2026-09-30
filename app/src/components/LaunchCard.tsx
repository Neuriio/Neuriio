// /launch — "Tokenize yourself". Center card: live token preview on the left, three short steps on the right
// (who you are -> profile -> launch). Launch = our backend signs a one-time pass for your X account, then your
// Neuriio wallet sends Launchpad.launch (with an optional first buy). Your token is always "@handle" / HANDLE.
// Tokens are memes: the copy says back / support / trade, never invest.
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Atom,
  Bot,
  BrainCircuit,
  Brush,
  ChartCandlestick,
  Check,
  ExternalLink,
  Flame,
  Hammer,
  Landmark,
  LoaderCircle,
  Megaphone,
  MemoryStick,
  Microscope,
  Orbit,
  Plus,
  Rocket,
  Upload,
  UserRound,
  Users,
  X,
  Zap,
} from "lucide-react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatEther, type Address, type EIP1193Provider } from "viem";
import { confirmed, elysiumProvider, walletClientFor } from "../lib/tx";
import { elysiumTestnet } from "../chain";
import { amount } from "../lib/format";
import { profileOf } from "../lib/profile";
import {
  ABOUT_MAX,
  ABOUT_MIN,
  CATEGORIES,
  type CategoryId,
  curveProgress,
  type CurveParams,
  estimateFirstBuy,
  fetchCurveParams,
  graduationMcapHype,
  LAUNCHPAD,
  launchArgs,
  ftfTokenOf,
  launchedTokenOf,
  launchFtfArgs,
  launchpadAbi,
  MAX_LINKS,
  pub,
  requestLaunchPass,
  SECTORS,
  type SectorId,
} from "../lib/launch";
import { EASE_OUT } from "../lib/motion";
import { SUPABASE_URL } from "../lib/config";
import { fileToBase64, FTF_NAME_RE, FTF_TICKER_RE, ftfCall, type FtfPassResponse, type FtfView } from "../lib/ftf";

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
};
const SECTOR_ICONS: Record<SectorId, typeof Flame> = {
  robotics: Bot,
  quantum: Atom,
  finance: Landmark,
  ai: BrainCircuit,
  energy: Zap,
  memory: MemoryStick,
  space: Orbit,
};
type Mode = "personal" | "ftf";
// "sector" is two parts in one step: the sector, then how you're active in it (the category)
type StepId = "type" | "members" | "sector" | "profile" | "launch";
const STEP_IDS: Record<Mode, StepId[]> = {
  personal: ["type", "sector", "profile", "launch"],
  ftf: ["type", "members", "sector", "profile", "launch"],
};
const STEP_LABEL: Record<StepId, string> = {
  type: "Type",
  members: "Members",
  sector: "Sector",
  profile: "Profile",
  launch: "Launch",
};
const FTF_SIZE = 4;
const STAGES = ["Checking your X account", "Launching on Elysium", "You're live"] as const;
const QUICK_BUYS = ["0", "0.1", "0.5", "1"];
const TESTNET_PARAMS: CurveParams = { virtualHype: 0.1, feeBps: 75 }; // until the chain answers

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

  if (!started && !launchedToken) {
    // (someone who already launched personally skips the intro; the Type step offers them an FTF)
    return (
      <LaunchIntro
        loggedIn={loggedIn}
        busy={!DEMO && !ready}
        onLogin={() => (DEMO ? setDemoIn(true) : login())}
        onStart={() => setStarted(true)}
      />
    );
  }
  if (DEMO) return <LaunchView handle="neuriio" avatar={null} demo />;
  return (
    <LaunchView
      handle={x?.username ?? me.name.replace("@", "")}
      avatar={me.avatar}
      address={wallet?.address as Address | undefined}
      getAccessToken={getAccessToken}
      getProvider={wallet ? () => elysiumProvider(wallet) : undefined}
    />
  );
}

const FTF_LINE =
  "The platform to tokenize your account and own your defi, or get 3 friends to form a FTF (Friends Turned Fam) and put everyone onchain.";

/**
 * First screen for everyone (750 x 350): "The future of ownership" + one button (Login / Launch). Launch plays a
 * short reveal of the FTF line in the same style, with Next in the bottom-right, which opens the 3-step flow.
 */
function LaunchIntro({
  loggedIn,
  busy,
  onLogin,
  onStart,
}: {
  loggedIn: boolean;
  busy: boolean;
  onLogin: () => void;
  onStart: () => void;
}) {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<"welcome" | "about">("welcome");
  const rise = (delay: number) =>
    reduce ? {} : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, delay, ease: EASE_OUT } };
  const leave = reduce ? {} : { exit: { opacity: 0, y: -14, filter: "blur(4px)", transition: { duration: 0.35, ease: EASE_OUT } } };
  const words = FTF_LINE.split(" ");

  return (
    <div className="panel card-slot launch-card launch-intro">
      <LaunchBg />
      <IntroCurve />
      {/* the Neuriio mark, top center on both intro screens (stays while the text changes) */}
      <motion.img className="li-mark" src="/brand/mark.png" alt="Neuriio" draggable={false} {...rise(0)} />
      <AnimatePresence mode="wait">
        {stage === "welcome" ? (
          <motion.div key="welcome" className="li-content" {...leave}>
            <motion.span className="li-kicker" {...rise(0)}>
              The future of ownership
            </motion.span>
            <motion.div {...rise(0.08)}>
              <button className="li-btn" onClick={loggedIn ? () => setStage("about") : onLogin} disabled={busy}>
                {loggedIn ? (
                  <>
                    <Rocket size={16} /> Launch
                  </>
                ) : (
                  "Login"
                )}
              </button>
            </motion.div>
          </motion.div>
        ) : (
          <motion.div key="about" className="li-content li-about">
            <p className="li-kicker li-ftf" aria-label={FTF_LINE}>
              {words.map((w, i) => (
                <motion.span
                  key={i}
                  aria-hidden
                  initial={reduce ? false : { opacity: 0, y: 8, filter: "blur(6px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  transition={{ duration: 0.45, delay: reduce ? 0 : 0.05 + i * 0.045, ease: EASE_OUT }}
                >
                  {w}{" "}
                </motion.span>
              ))}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {stage === "about" && (
          <motion.button
            key="next"
            className="li-btn li-next"
            onClick={onStart}
            initial={reduce ? false : { opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, delay: reduce ? 0 : 0.05 + words.length * 0.045, ease: EASE_OUT }}
          >
            Next <ArrowRight size={15} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
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
  const [mode, setMode] = useState<Mode | null>(null);
  const [personalToken, setPersonalToken] = useState<Address | null>(null);
  const [step, setStep] = useState(0);
  // FTF being formed
  const [ftf, setFtf] = useState<FtfView>({ draft: null, members: [] });
  const [ftfName, setFtfName] = useState("");
  const [ftfTicker, setFtfTicker] = useState("");
  const [invites, setInvites] = useState(["", "", ""]);
  const [ftfBusy, setFtfBusy] = useState(false);
  const [ftfError, setFtfError] = useState<string | null>(null);
  const [sector, setSector] = useState<SectorId | null>(null);
  const [sectorPart, setSectorPart] = useState<"sector" | "role">("sector");
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [about, setAbout] = useState("");
  const [links, setLinks] = useState<Link[]>([{ label: "X", url: `https://x.com/${handle}` }]);
  const [firstBuy, setFirstBuy] = useState("0");
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [params, setParams] = useState<CurveParams>(TESTNET_PARAMS);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    fetchCurveParams().then(setParams).catch(() => {});
  }, []);
  // already launched personally? (one per X account and wallet) Then only an FTF is left to launch.
  useEffect(() => {
    if (!address) return;
    launchedTokenOf(address).then(setPersonalToken).catch(() => {});
    pub.getBalance({ address }).then((b) => setBalance(Number(formatEther(b)))).catch(() => {});
  }, [address]);

  const ids = STEP_IDS[mode ?? "personal"];
  const current = ids[step];
  const tokenFor = getAccessToken ?? (async () => null);
  const acceptedCount = ftf.members.filter((m) => m.status === "accepted").length;

  // FTF: pick up the one you're forming (resume), and keep member statuses fresh while on Members
  const loadFtf = async () => {
    const v = await ftfCall<FtfView>(tokenFor, "mine");
    setFtf(v);
    if (v.draft) {
      if (v.draft.sector) {
        setSector(v.draft.sector);
        setSectorPart("role");
      }
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
    const id = setInterval(() => loadFtf().catch(() => {}), 4_000);
    return () => clearInterval(id);
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
  const est = useMemo(() => estimateFirstBuy(buy, params), [buy, params]);
  const ticker = mode === "ftf" ? (ftf.draft?.ticker ?? ftfTicker.trim().toUpperCase()) || "TICKER" : handle.toUpperCase();
  const cleanLinks = links.filter((l) => l.label.trim() && l.url.trim());
  const linksOk = cleanLinks.every((l) => /^https:\/\/\S+\.\S+/.test(l.url.trim()));
  const aboutLen = about.trim().length;
  const ftfTickerOk = FTF_TICKER_RE.test(ftfTicker.trim());
  const ftfNameOk = ftfName.trim().length > 0 && ftfName.trim().length <= 32 && FTF_NAME_RE.test(ftfName.trim());
  const inviteHandles = invites.map((x) => x.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
  const invitesOk = inviteHandles.length === FTF_SIZE - 1 && new Set(inviteHandles).size === inviteHandles.length
    && inviteHandles.every((h) => /^[a-z0-9_]{1,15}$/.test(h) && h !== handle.toLowerCase());
  const canNext = {
    type: mode !== null && !(mode === "personal" && personalToken),
    members: acceptedCount === FTF_SIZE,
    sector: sector !== null && category !== null && sectorPart === "role",
    profile: aboutLen >= ABOUT_MIN && aboutLen <= ABOUT_MAX && linksOk,
    launch: agreed && buy >= 0,
  }[current];
  const isFtf = mode === "ftf";
  const ftfTickerShown = ftf.draft?.ticker ?? (ftfTicker.trim().toUpperCase() || "TICKER");
  const lowGas = balance !== null && balance < buy + 0.0005 && !demo;

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
        const { args, value } = launchFtfArgs(r, buy, params);
        const hash = await walletClientFor(provider, address!).writeContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "launchFtf", args, value });
        await confirmed(hash);
        fetch(`${SUPABASE_URL}/functions/v1/indexer`, { method: "POST" }).catch(() => {});
        setPhase({ kind: "live", token: await ftfTokenOf(r.pass.ticker) });
        return;
      }
      const token = await getAccessToken!();
      if (!token) throw new Error("Session expired, log in again");
      const pass = await requestLaunchPass(token, {
        sector: sector!,
        category: category!,
        profile: { about: about.trim(), links: cleanLinks.map((l) => ({ label: l.label.trim(), url: l.url.trim() })) },
      });
      setPhase({ kind: "launching", stage: 1 });
      const provider = await getProvider!();
      const { args, value } = launchArgs(pass, buy, params);
      const hash = await walletClientFor(provider, address!).writeContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "launch", args, value });
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
              <span className="lp-ticker">${isFtf ? ftfTickerShown : ticker}</span>
            </div>
          </div>
          {isFtf && (
            <div className="lp-members-mini" aria-label="Members">
              {Array.from({ length: FTF_SIZE }, (_, i) => {
                const m = ftf.members.filter((x) => x.status !== "declined")[i];
                const ok = m?.status === "accepted";
                return (
                  <span key={i} className={`lp-member-dot${ok ? " is-in" : m ? " is-pending" : ""}`} title={m?.x_handle ? `@${m.x_handle}` : "Open spot"}>
                    {m?.x_pfp_url ? <img src={m.x_pfp_url} alt="" referrerPolicy="no-referrer" /> : m?.x_handle ? m.x_handle[0].toUpperCase() : "+"}
                  </span>
                );
              })}
              <span className="lp-members-count">{acceptedCount}/{FTF_SIZE} in</span>
            </div>
          )}
          <div className={`lp-chip${sector ? "" : " lp-chip-empty"}`}>
            {sector
              ? [SECTORS.find((x) => x.id === sector)!.label, category && CATEGORIES.find((c) => c.id === category)!.label].filter(Boolean).join(" · ")
              : "Pick a sector"}
          </div>
          <CurveChart progress={curveProgress(buy, params)} />
          <dl className="lp-stats">
            <div>
              <dt>Supply</dt>
              <dd>1B</dd>
            </div>
            <div>
              <dt>Graduates at</dt>
              <dd>{mcap(graduationMcapHype(params))} HYPE mcap</dd>
            </div>
            <div>
              <dt>Curve fee</dt>
              <dd>{params.feeBps / 100}%</dd>
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
                        {personalToken ? `You already launched @${handle}` : `Your own token: @${handle} / $${handle.toUpperCase()}`}
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
                            value={ftfTicker}
                            maxLength={10}
                            placeholder="DEN"
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
                        {ftf.draft.name} <span className="lp-count">${ftf.draft.ticker}</span>
                      </p>
                      <ul className="lp-member-list">
                        {ftf.members.filter((m) => m.status !== "declined" || m.role === "member").map((m) => (
                          <li key={m.x_user_id} className={`lp-member is-${m.status}`}>
                            <span className="lp-member-av">
                              {m.x_pfp_url ? <img src={m.x_pfp_url} alt="" referrerPolicy="no-referrer" /> : (m.x_handle ?? "?")[0].toUpperCase()}
                            </span>
                            <span className="lp-member-name">
                              @{m.x_handle ?? "unknown"}
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
                                aria-label={`Remove @${m.x_handle}`}
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
                          ? "All 4 are in. Next: sector, profile and picture."
                          : `${acceptedCount}/${FTF_SIZE} in. Waiting for everyone to accept from their notifications.`}
                      </p>
                    </>
                  )}
                  {ftfError && <p className="lp-warn">{ftfError}</p>}
                </motion.div>
              )}

              {phase.kind === "form" && current === "sector" && sectorPart === "sector" && (
                <motion.div key="s0-sector" className="lp-pane" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  <p className="lp-q">{isFtf ? "What sector is this FTF?" : "What sector are you?"}</p>
                  <div className="lp-cats lp-sectors">
                    {SECTORS.map((x) => {
                      const Icon = SECTOR_ICONS[x.id];
                      return (
                        <button
                          key={x.id}
                          className={`lp-cat${sector === x.id ? " is-on" : ""}`}
                          onClick={() => {
                            setSector(x.id);
                            setSectorPart("role");
                          }}
                        >
                          <Icon size={16} strokeWidth={1.8} />
                          <span className="lp-cat-label">{x.label}</span>
                          <span className="lp-cat-hint">{x.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {phase.kind === "form" && current === "sector" && sectorPart === "role" && (
                <motion.div key="s0-role" className="lp-pane" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  <p className="lp-q">
                    {isFtf ? "How is this FTF active in the sector?" : "How are you active in the sector?"}
                    <button className="link-btn lp-sector-pick" onClick={() => setSectorPart("sector")}>
                      {SECTORS.find((x) => x.id === sector)?.label} · change
                    </button>
                  </p>
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
                        FTF picture <span className="lp-count">PNG, JPEG or WebP · up to 512 KB</span>
                      </span>
                      <label className="lp-pfp">
                        <span className="lp-pfp-preview">{ftf.draft?.pfpUrl ? <img src={ftf.draft.pfpUrl} alt="" /> : <Users size={18} />}</span>
                        <span className="link-btn">
                          <Upload size={12} /> {ftf.draft?.pfpUrl ? "Change picture" : "Upload picture"}
                        </span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
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
                      {links.map((l, i) => (
                        <div key={i} className="lp-link">
                          <input
                            className="lp-link-label"
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
                      ))}
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
                      <span className="lp-buy-unit">HYPE</span>
                    </div>
                    <div className="lp-quick">
                      {QUICK_BUYS.map((q) => (
                        <button key={q} className={`lp-quick-btn${firstBuy === q ? " is-on" : ""}`} onClick={() => setFirstBuy(q)}>
                          {q === "0" ? "None" : q}
                        </button>
                      ))}
                      {balance !== null && <span className="lp-balance">Balance {amount(balance)} HYPE</span>}
                    </div>
                    <p className="lp-est">
                      {buy > 0 ? (
                        <>
                          You get <b>~{amount(Math.round(est.tokens))} ${ticker}</b> · {est.pctOfSupply.toFixed(2)}% of supply
                        </>
                      ) : (
                        <>Launch with no first buy. Anyone can be first.</>
                      )}
                    </p>
                    {lowGas && <p className="lp-warn">Add HYPE to your Neuriio wallet on Elysium first (Account → deposit address).</p>}
                  </div>
                  <label className="lp-agree">
                    <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                    <span>
                      I understand {isFtf ? `$${ticker}` : `@${handle}`} has no promise of value or promise any returns to anyone.
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
                  <p className="lp-live-title">{isFtf ? `${ftf.draft?.name ?? "Your FTF"} ($${ticker})` : `@${handle}`} is live</p>
                  <p className="lp-live-sub">Your token trades on its bonding curve now. It graduates to a locked pool when the curve sells out.</p>
                  <div className="lp-live-actions">
                    <a
                      className="lock-login lp-cta"
                      target="_blank"
                      rel="noreferrer"
                      href={`https://x.com/intent/post?text=${encodeURIComponent(
                        isFtf ? `Our FTF $${ticker} is live on @Neuriio` : `I just tokenized my account: $${ticker} is live on @Neuriio`,
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
                onClick={() => (current === "sector" && sectorPart === "role" ? setSectorPart("sector") : setStep(step - 1))}
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
                    // FTF: save sector + category + profile before the launch step (the pass is signed from what's saved)
                    if (isFtf && current === "profile") {
                      try {
                        await ftfDo("profile", {
                          draftId: ftf.draft!.id,
                          sector,
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
                  <Rocket size={13} /> Launch ${ticker}
                </button>
              )}
            </footer>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Intro decoration for the bare left side: the launchpad's own bonding curve (price vs. tokens sold), rising from
 * the bottom-left into the dots on the right. It draws itself in, then a glowing dot climbs it on a loop.
 */
const CURVE_W = 750;
const CURVE_H = 350;
const CURVE_PATH = (() => {
  const pts = Array.from({ length: 61 }, (_, i) => {
    const s = i / 60;
    const p = (1_073 / (1_073 - s * 793.1)) ** 2; // 1 -> ~14.7 over the curve
    return [s * CURVE_W, CURVE_H - 26 - ((p - 1) / 13.7) * (CURVE_H - 70)] as const;
  });
  return pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
})();

function IntroCurve() {
  return (
    <div className="li-curve" aria-hidden>
      <span className="li-corner-glow" />
      <svg viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="li-curve-stroke" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#8c7d9f" stopOpacity="0" />
            <stop offset="0.35" stopColor="#b3a3d6" stopOpacity="0.55" />
            <stop offset="1" stopColor="#d8fffe" stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id="li-curve-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#b3a3d6" stopOpacity="0.14" />
            <stop offset="1" stopColor="#b3a3d6" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${CURVE_PATH} L${CURVE_W},${CURVE_H} L0,${CURVE_H} Z`} fill="url(#li-curve-fill)" className="li-curve-area" />
        <path d={CURVE_PATH} pathLength={1} className="li-curve-line" stroke="url(#li-curve-stroke)" />
      </svg>
      <span className="li-curve-dot" style={{ offsetPath: `path("${CURVE_PATH}")` }} />
    </div>
  );
}

/** Shared card background for the intro and the flow: dot grid + two slow glows. */
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

/** Bonding-curve price vs. tokens sold, with the first buy filled in. */
function CurveChart({ progress }: { progress: number }) {
  const W = 262;
  const H = 96;
  // price ∝ 1 / (virtual tokens left)^2 over the 793.1M sold on the curve
  const pts = Array.from({ length: 41 }, (_, i) => {
    const s = i / 40;
    const left = 1_073 - s * 793.1;
    return [s, (1_073 / left) ** 2] as const;
  });
  const max = pts[pts.length - 1][1];
  const xy = ([s, p]: readonly [number, number]) => [s * W, H - 4 - ((p - 1) / (max - 1)) * (H - 8)] as const;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${xy(p)[0].toFixed(1)},${xy(p)[1].toFixed(1)}`).join("");
  const filled = pts.filter(([s]) => s <= progress);
  const area = filled.length > 1 ? `M0,${H} ${filled.map((p) => `L${xy(p)[0].toFixed(1)},${xy(p)[1].toFixed(1)}`).join(" ")} L${(progress * W).toFixed(1)},${H} Z` : "";
  const dot = xy([progress, (1_073 / (1_073 - progress * 793.1)) ** 2]);
  return (
    <div className="lp-curve">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} aria-hidden>
        <path d={line} className="lp-curve-line" />
        {area && <path d={area} className="lp-curve-fill" />}
        <circle cx={dot[0]} cy={dot[1]} r={3.2} className="lp-curve-dot" />
      </svg>
      <div className="lp-curve-axis">
        <span>Launch</span>
        <span>Graduation</span>
      </div>
    </div>
  );
}

/** 822 / 1.37: whole numbers when big, 2 decimals when small (testnet's tiny curve). */
const mcap = (n: number) => (n >= 100 ? amount(Math.round(n)) : n.toFixed(2));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function friendly(msg: string) {
  if (/already launched/i.test(msg)) return "You already launched your token. One per X account.";
  if (/insufficient funds/i.test(msg)) return "Not enough HYPE for this first buy plus gas.";
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
