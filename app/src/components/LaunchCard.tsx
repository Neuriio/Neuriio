// /launch — "Tokenize yourself". Center card: live token preview on the left, three short steps on the right
// (who you are -> profile -> launch). Launch = our backend signs a one-time pass for your X account, then your
// Neuriio wallet sends Launchpad.launch (with an optional first buy). Your token is always "@handle" / HANDLE.
// Tokens are memes: the copy says back / support / trade, never invest.
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Brush,
  ChartCandlestick,
  Check,
  ExternalLink,
  Flame,
  Hammer,
  LoaderCircle,
  Megaphone,
  Microscope,
  Plus,
  Rocket,
  X,
} from "lucide-react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom, formatEther, type Address } from "viem";
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
  launchedTokenOf,
  launchpadAbi,
  MAX_LINKS,
  pub,
  requestLaunchPass,
} from "../lib/launch";
import { EASE_OUT } from "../lib/motion";

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
const STEPS = ["Who you are", "Profile", "Launch"] as const;
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
      getProvider={wallet ? async () => (await wallet.switchChain(elysiumTestnet.id), wallet.getEthereumProvider()) : undefined}
    />
  );
}

const FTF_LINE =
  "The platform to grow your brand or combine yourself with friends to form a FTF (Friends Turned Fam) where you and 3 others create a group ticker.";

/**
 * First screen for everyone (750 x 350): "The Future for Creators" + one button (Login / Launch). Launch plays a
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
      <AnimatePresence mode="wait">
        {stage === "welcome" ? (
          <motion.div key="welcome" className="li-content" {...leave}>
            <motion.span className="li-kicker" {...rise(0)}>
              The Future for Creators
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
  getProvider?: () => Promise<unknown>;
};

function LaunchView({ handle, avatar, address, demo, getAccessToken, getProvider }: ViewProps) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
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
  // already launched? (one token per X account and wallet)
  useEffect(() => {
    if (!address) return;
    launchedTokenOf(address).then((t) => t && setPhase({ kind: "live", token: t })).catch(() => {});
    pub.getBalance({ address }).then((b) => setBalance(Number(formatEther(b)))).catch(() => {});
  }, [address]);

  const buy = Number(firstBuy) || 0;
  const est = useMemo(() => estimateFirstBuy(buy, params), [buy, params]);
  const ticker = handle.toUpperCase();
  const cleanLinks = links.filter((l) => l.label.trim() && l.url.trim());
  const linksOk = cleanLinks.every((l) => /^https:\/\/\S+\.\S+/.test(l.url.trim()));
  const aboutLen = about.trim().length;
  const canNext = [category !== null, aboutLen >= ABOUT_MIN && aboutLen <= ABOUT_MAX && linksOk, agreed && buy >= 0][step];
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
      const token = await getAccessToken!();
      if (!token) throw new Error("Session expired, log in again");
      const pass = await requestLaunchPass(token, {
        category: category!,
        profile: { about: about.trim(), links: cleanLinks.map((l) => ({ label: l.label.trim(), url: l.url.trim() })) },
      });
      setPhase({ kind: "launching", stage: 1 });
      const provider = await getProvider!();
      const walletClient = createWalletClient({
        account: address!,
        chain: elysiumTestnet,
        transport: custom(provider as Parameters<typeof custom>[0]),
      });
      const { args, value } = launchArgs(pass, buy, params);
      const hash = await walletClient.writeContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "launch", args, value });
      await pub.waitForTransactionReceipt({ hash });
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
              {avatar ? <img src={avatar} alt="" /> : <span>{handle.charAt(0).toUpperCase()}</span>}
            </div>
            <div className="lp-names">
              <span className="lp-name">@{handle}</span>
              <span className="lp-ticker">${ticker}</span>
            </div>
          </div>
          <div className={`lp-chip${category ? "" : " lp-chip-empty"}`}>
            {category ? CATEGORIES.find((c) => c.id === category)!.label : "Pick a category"}
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
            {STEPS.map((s, i) => {
              const done = i < step || phase.kind === "live";
              return (
                <button
                  key={s}
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
              {phase.kind === "form" && step === 0 && (
                <motion.div key="s0" className="lp-pane" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  <p className="lp-q">What are you known for?</p>
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

              {phase.kind === "form" && step === 1 && (
                <motion.div key="s1" className="lp-pane" {...slide} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  <label className="lp-field">
                    <span className="lp-label">
                      About you
                      <span className={`lp-count${aboutLen > 0 && (aboutLen < ABOUT_MIN || aboutLen > ABOUT_MAX) ? " is-bad" : ""}`}>
                        {aboutLen < ABOUT_MIN ? `${ABOUT_MIN - aboutLen} more to go` : `${aboutLen}/${ABOUT_MAX}`}
                      </span>
                    </span>
                    <textarea
                      value={about}
                      maxLength={ABOUT_MAX}
                      onChange={(e) => setAbout(e.target.value)}
                      placeholder="Who you are, what you do, what people can see you've done."
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

              {phase.kind === "form" && step === 2 && (
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
                    <span>I understand @{handle} has no promise of value or promise any returns to anyone.</span>
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
                  <p className="lp-live-title">@{handle} is live</p>
                  <p className="lp-live-sub">Your token trades on its bonding curve now. It graduates to a locked pool when the curve sells out.</p>
                  <div className="lp-live-actions">
                    <a
                      className="lock-login lp-cta"
                      target="_blank"
                      rel="noreferrer"
                      href={`https://x.com/intent/post?text=${encodeURIComponent(`I just tokenized my account: $${ticker} is live on @Neuriio`)}`}
                    >
                      Share on X
                    </a>
                    <a className="link-btn" href={`/explore?t=${handle}${DEMO ? "&demo" : ""}`}>
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
              <button className="link-btn lp-back" onClick={() => setStep(step - 1)} disabled={step === 0}>
                <ArrowLeft size={12} /> Back
              </button>
              {step < 2 ? (
                <button className="lock-login lp-cta" disabled={!canNext} onClick={() => setStep(step + 1)}>
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
