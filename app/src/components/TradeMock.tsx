// LOCAL MOCKUP ONLY (2026-10-24): the Trade Arena flow (TRADE_ARENA.md) as static screens with fake data, to agree the
// design before the trade engine is built. Not wired to the contract or Supabase; never ship as is.
// Screens (the strip at the top switches them): Lobby -> Queue -> Match found -> Live match -> Result.
// Same shell as Explore: one connected widget on top (sections split by lines), a second widget below.
import { useEffect, useRef, useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import type { Address } from "viem";
import { useBalances } from "../lib/useBalances";
import { useAllBbo, type PerpMarket } from "../lib/perps";
import {
  equity,
  liqPrice,
  MAX_OPEN,
  MIN_AVG_HOLD_MS,
  MIN_TRADES,
  orderError,
  pnlAt,
  qualification,
  realized as realizedOf,
  START_BALANCE,
} from "../lib/arenaEngine";
import { useArenaAccount } from "../lib/useArenaAccount";
import { Avatar } from "./Avatar";
import { PerpChart } from "./PerpChart";
import "./trade-mock.css";
import { LitDots } from "./LitDots";

type Step = "lobby" | "queue" | "found" | "live" | "result";
const STEPS: { id: Step; label: string }[] = [
  { id: "lobby", label: "1 · Lobby" },
  { id: "queue", label: "2 · Queue" },
  { id: "found", label: "3 · Match found" },
  { id: "live", label: "4 · Live match" },
  { id: "result", label: "5 · Result" },
];

const TIERS = [
  { wager: 0.1, waiting: 1, live: 6 },
  { wager: 1, waiting: 0, live: 3 },
  { wager: 5, waiting: 1, live: 1 },
  { wager: 10, waiting: 0, live: 0 },
];
const RAKE = 0.15;
const GAS = 0.01; // kept back for gas
const ME = "you";
const OPP = "degen_kai";
const fmtHype = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} HYPE`;
const usd = (n: number, sign = false) =>
  `${sign && n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function TradeMock() {
  const [step, setStep] = useState<Step>(() => (new URLSearchParams(location.search).get("step") as Step) || "lobby");
  const [tier, setTier] = useState(1);
  const go = (s: Step) => {
    setStep(s);
    history.replaceState(null, "", `/trade?step=${s}`);
  };
  return (
    <div className="ex-grid ta">
      <nav className="ta-steps" aria-label="Mockup screens">
        <span className="ta-steps-tag">Mockup</span>
        {STEPS.map((s) => (
          <button key={s.id} className={`ta-step${step === s.id ? " is-on" : ""}`} onClick={() => go(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>
      {step === "lobby" && <Lobby onEnter={(w) => (setTier(w), go("queue"))} />}
      {step === "queue" && <Lobby queued={tier} onLeave={() => go("lobby")} onMatched={() => go("found")} />}
      {step === "found" && <Found wager={tier} onStart={() => go("live")} />}
      {step === "live" && <Live wager={tier} />}
      {step === "result" && <Result wager={tier} onAgain={() => go("queue")} />}
    </div>
  );
}

/* ------------------------------------------------------------------ 1 + 2: lobby, and the same lobby while queued */

function Lobby({
  queued,
  onEnter,
  onLeave,
  onMatched,
}: {
  queued?: number;
  onEnter?: (wager: number) => void;
  onLeave?: () => void;
  onMatched?: () => void;
}) {
  const waited = useTicker(queued !== undefined);
  const hype = useWalletHype(); // null while logged out or loading: nothing is greyed out then
  return (
    <>
      {/* the 4 wager tiers, each its own small widget, centered on the page (user, 2026-10-25) */}
      <div className="ta-lobby-stage">
        <header className="ta-intro">
          <h1 className="ta-intro-h">Each Match You Start with $10k</h1>
          <p className="ta-intro-sub">Synthetic Trading against Real HL prices.</p>
          <p className="ta-intro-body">Winner Takes All</p>
        </header>
        <div className="ta-tiers">
          {TIERS.map((t) => {
            const mine = queued === t.wager;
            const broke = hype !== null && hype < t.wager + GAS; // not enough in the Neuriio wallet for this wager
            const locked = (queued !== undefined && !mine) || broke;
            const win = t.wager * 2 * (1 - RAKE);
            return (
              <section key={t.wager} className={`ta-tier${mine ? " is-queued" : ""}${locked ? " is-locked" : ""}`}>
                <span className="ta-tier-label">Wager</span>
                <span className="ta-tier-wager">{fmtHype(t.wager)}</span>
                <span className="ta-tier-win">
                  Win <b>{fmtHype(win)}</b>
                </span>
                {mine ? (
                  <div className="ta-radar" aria-hidden>
                    <span />
                    <span />
                    <span />
                    <Avatar handle={ME} pfp={null} size={28} className="ta-radar-me" />
                  </div>
                ) : (
                  <dl className="ta-tier-stats">
                    <div>
                      <dt>Waiting</dt>
                      <dd className={t.waiting ? "ta-live-dot" : undefined}>{t.waiting ? "1 player" : "Empty"}</dd>
                    </div>
                    <div>
                      <dt>Live matches</dt>
                      <dd>{t.live}</dd>
                    </div>
                  </dl>
                )}
                {mine ? (
                  <>
                    <p className="ta-queue-text">
                      Finding your opponent <span className="ta-mono">{clock(waited)}</span>
                    </p>
                    <p className="ta-queue-note">First in line · next player starts the match</p>
                    <button className="ta-btn is-ghost" onClick={onLeave}>
                      Leave
                    </button>
                    <button className="ta-mock-link" onClick={onMatched}>
                      (mockup: opponent joins)
                    </button>
                  </>
                ) : (
                  <button
                    className="ta-btn"
                    disabled={locked}
                    title={broke ? `Your Neuriio wallet has ${fmtHype(hype ?? 0)}` : undefined}
                    onClick={() => onEnter?.(t.wager)}
                  >
                    Enter
                  </button>
                )}
              </section>
            );
          })}
        </div>
      </div>
      <LitDots selector=".ta-tier" />
    </>
  );
}

/** Live matches table: kept for later, not on the lobby while the user picks a spot for it (2026-10-25). */
export function LiveMatches() {
  return (
    <section className="ex-card ex-positions-card ta-board">
      <div className="ta-board-head">
        <span className="ta-board-title">Live matches</span>
        <span className="ta-board-sub">10 live · anyone can watch</span>
      </div>
      <table className="ta-table">
        <thead>
          <tr>
            <th>Match</th>
            <th>Wager</th>
            <th>Leader</th>
            <th>PnL</th>
            <th>Time left</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["moonmath", "rektlord", 0.1, "moonmath", 18.4, "21:12:40"],
            ["0xshorty", "wenlambo", 1, "wenlambo", 6.1, "09:03:11"],
            ["hypeboi", "satsquatch", 5, "satsquatch", 31.9, "02:47:05"],
            ["ape_fren", "lowcap_larry", 0.1, "ape_fren", -2.3, "15:30:58"],
          ].map(([a, b, w, lead, pnl, left]) => (
            <tr key={a as string}>
              <td>
                <span className="ta-vs-row">
                  <Avatar handle={a as string} pfp={null} size={22} />@{a} <i>vs</i>
                  <Avatar handle={b as string} pfp={null} size={22} />@{b}
                </span>
              </td>
              <td>{fmtHype(w as number)}</td>
              <td>@{lead}</td>
              <td className={(pnl as number) >= 0 ? "price-up" : "price-down"}>
                {(pnl as number) >= 0 ? "+" : ""}
                {pnl}%
              </td>
              <td className="ta-mono">{left}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------------------ 3: match found */

/** Match found: "Trade" (or the countdown reaching 0s) sends your wager from your Neuriio wallet to the escrow (one
 *  click, no pop-up; the matchmaker's signed ticket). The match starts when both are in; a no-show is refunded after
 *  the deadline. */
function Found({ wager, onStart }: { wager: number; onStart: () => void }) {
  const [phase, setPhase] = useState<"ready" | "sending" | "waiting" | "go">("ready");
  const [oppIn, setOppIn] = useState(false);
  const left = useCountdown(60);
  // at 0s, whoever hasn't pressed Trade is moved forward: the app sends their deposit itself (works while Neuriio is
  // open; a closed tab can't sign, so that player is a no-show and the other is refunded). The ticket's deadline is
  // 30 s past the countdown so a deposit sent at 0s still lands.
  useEffect(() => {
    if (left === 0 && phase === "ready") setPhase("sending");
  }, [left, phase]);
  // mockup: the opponent goes in a few seconds after the page opens; your deposit takes ~1.5 s
  useEffect(() => {
    const id = setTimeout(() => setOppIn(true), 6000);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    if (phase !== "sending") return;
    const id = setTimeout(() => setPhase("waiting"), 1500);
    return () => clearTimeout(id);
  }, [phase]);
  useEffect(() => {
    if (phase === "waiting" && oppIn) setPhase("go");
  }, [phase, oppIn]);
  const start = useRef(onStart);
  start.current = onStart;
  useEffect(() => {
    if (phase !== "go") return;
    const id = setTimeout(() => start.current(), 1200);
    return () => clearTimeout(id);
  }, [phase]);
  const meIn = phase === "waiting" || phase === "go";
  return (
    <div className="ex-main ta-main ta-found">
      <span className="ta-found-tag">Match found · {fmtHype(wager)} each</span>
      <div className="ta-found-row">
        <Player handle={ME} side="left" note={meIn ? "In ✓" : "You"} done={meIn} />
        <div className="ta-found-mid">
          <span className="ta-found-vs">VS</span>
          <span className="ta-found-pot">
            Pot {fmtHype(wager * 2)}
            <small>winner gets {fmtHype(wager * 2 * (1 - RAKE))}</small>
          </span>
        </div>
        <Player handle={OPP} side="right" note={oppIn ? "In ✓" : "Not in yet"} done={oppIn} />
      </div>
      <div className="ta-found-count">
        {phase === "ready" && (
          <button className="ta-btn is-big" onClick={() => setPhase("sending")}>
            Trade
          </button>
        )}
        {phase === "sending" && <span className="ta-found-status">Sending {fmtHype(wager)} to the match…</span>}
        {phase === "waiting" && <span className="ta-found-status">You're in · waiting for @{OPP}…</span>}
        {phase === "go" && <span className="ta-found-status is-go">Entering...</span>}
        {phase !== "go" && <span className="ta-found-timer">{left}s</span>}
      </div>
      <LitDots selector=".ta-found-count .ta-btn" />
    </div>
  );
}

function Player({
  handle,
  side,
  note,
  done,
}: {
  handle: string;
  side: "left" | "right";
  note: string;
  done?: boolean;
}) {
  return (
    <div className={`ta-player is-${side}${done ? " is-in" : ""}`}>
      <Avatar handle={handle} pfp={null} size={96} className="ta-player-avatar" />
      <span className="ta-player-handle">@{handle}</span>
      <span className="ta-player-note">{note}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ 4: live match */

function Live({ wager }: { wager: number }) {
  const [market, setMarket] = useState<PerpMarket>("BTC");
  const [side, setSide] = useState<"long" | "short">("long");
  const [lev, setLev] = useState(20);
  const [margin, setMargin] = useState("1000");
  const [paused, setPaused] = useState(false); // mockup: the watcher's price is older than 2 s
  // live Hyperliquid mainnet prices (lib/perps.ts); the positions and the opponent are still fake
  const live = useAllBbo();
  const bbo = live[market];
  const price = bbo?.mid ?? 0;
  const left = useCountdown(23 * 3600 + 41 * 60 + 8);
  // shown as paused when no tick has come for 5 s (Hyperliquid only sends the bid/ask when it changes, so a quiet
  // second isn't a dead feed; the trade engine's own 2 s rule is on the watcher's connection, not this)
  useTicker(true); // re-check every second
  const stale = paused || !bbo || Date.now() - bbo.at > 5_000;

  // your account: real orders on live prices, run in this browser for now (useArenaAccount; preview only)
  const { account, open, close, reset } = useArenaAccount(live);
  const [orderMsg, setOrderMsg] = useState<string | null>(null);
  const mids = { BTC: live.BTC?.mid, ETH: live.ETH?.mid };
  const myPnl = equity(account, mids) - START_BALANCE;
  const realized = realizedOf(account);
  const qual = qualification(account);
  // the opponent is still fake: drifts with BTC from the first price seen
  const anchor = useRef<number | null>(null);
  if (live.BTC && anchor.current === null) anchor.current = live.BTC.mid;
  const oppPnl = 286 + (anchor.current && live.BTC ? (live.BTC.mid - anchor.current) * 0.9 : 0);
  const lead = Math.max(-1, Math.min(1, (myPnl - oppPnl) / 1500));

  const m = Number(margin) || 0;
  const fillAt = bbo ? (side === "long" ? bbo.ask : bbo.bid) : 0; // where this order would fill now
  const liq = fillAt ? liqPrice(side, fillAt, lev) : 0;
  const err = orderError(account, m, lev);
  const place = () => {
    const e = open(market, side, lev, m);
    setOrderMsg(e ?? `${side === "long" ? "Long" : "Short"} ${market} ${lev}x filled at ${fillAt.toFixed(dp(market))}`);
  };

  return (
    <>
      <div className="ex-main ta-main ta-live">
        {/* left: the scoreboard */}
        <section className="ex-card ta-score">
          <div className="ta-clock">
            <span className="ta-clock-label">Time left</span>
            <span className="ta-clock-value ta-mono">{clock(left)}</span>
            <span className="ta-clock-sub">
              {fmtHype(wager)} each · winner gets {fmtHype(wager * 2 * (1 - RAKE))}
            </span>
          </div>
          <div className="ta-tug" aria-label="Who's ahead">
            <span
              className="ta-tug-fill"
              style={{
                left: "50%",
                width: `${Math.abs(lead) * 50}%`,
                transform: lead < 0 ? "translateX(-100%)" : undefined,
              }}
              data-side={lead >= 0 ? "me" : "opp"}
            />
            <span className="ta-tug-mid" />
          </div>
          <Score handle={ME} label="You" pnl={myPnl} balance={10_000 + myPnl} ahead={myPnl >= oppPnl} />
          <Score handle={OPP} label="Opponent" pnl={oppPnl} balance={10_000 + oppPnl} ahead={oppPnl > myPnl} />
          <p className="ta-qual-note">Your numbers move with every tick; your opponent's update once a second.</p>
          <div className="ta-qual">
            <span className="ta-qual-title">To qualify</span>
            <Meter label="Trades" value={`${qual.trades} / ${MIN_TRADES}`} pct={qual.trades / MIN_TRADES} />
            <Meter
              label="Avg hold"
              value={`${clock(Math.floor(qual.avgHoldMs / 1000))} / ${clock(MIN_AVG_HOLD_MS / 1000)}`}
              pct={qual.avgHoldMs / MIN_AVG_HOLD_MS}
            />
            <p className="ta-qual-note">Miss either and you lose the match. @{OPP}: qualified ✓</p>
          </div>
        </section>

        {/* center: market + chart */}
        <section className="ex-card ta-chart-card">
          <header className="ta-chart-head">
            <div className="ta-mkts" role="tablist">
              {(["BTC", "ETH"] as const).map((k) => (
                <button key={k} className={`ta-mkt${market === k ? " is-on" : ""}`} onClick={() => setMarket(k)}>
                  {k}-PERP
                </button>
              ))}
            </div>
            <span className="ta-price ta-mono">
              $
              {price
                ? price.toLocaleString("en-US", {
                    minimumFractionDigits: dp(market),
                    maximumFractionDigits: dp(market),
                  })
                : "…"}
            </span>
            <span className="ta-bbo">
              Bid <b className="price-down">{bbo ? bbo.bid.toFixed(dp(market)) : "…"}</b> · Ask{" "}
              <b className="price-up">{bbo ? bbo.ask.toFixed(dp(market)) : "…"}</b>
            </span>
            <span className={`ta-feed${stale ? " is-paused" : ""}`}>
              {stale ? "Price feed paused" : "Live · Hyperliquid"}
            </span>
            <span className="ta-src">Play money</span>
          </header>
          <PerpChart market={market} />
        </section>

        {/* right: order */}
        <section className="ex-card ta-order">
          <div className="ex-order-tabs ta-sides" role="tablist">
            <button className={`ex-order-tab is-buy${side === "long" ? " is-on" : ""}`} onClick={() => setSide("long")}>
              Long
            </button>
            <button
              className={`ex-order-tab is-sell${side === "short" ? " is-on" : ""}`}
              onClick={() => setSide("short")}
            >
              Short
            </button>
          </div>
          <label className="ta-field">
            <span className="ta-field-row">
              <span className="ta-label">Margin</span>
              <span className="ta-free">Free {usd(account.cash)}</span>
            </span>
            <span className="ex-order-input">
              <input
                inputMode="decimal"
                value={margin}
                onChange={(e) => {
                  setMargin(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"));
                  setOrderMsg(null);
                }}
              />
              <span className="ex-order-unit">USD</span>
            </span>
          </label>
          <div className="ta-field">
            <span className="ta-field-row">
              <span className="ta-label">Leverage</span>
              <span className="ta-lev-value">{lev}x</span>
            </span>
            <input
              className="ta-slider"
              type="range"
              min={1}
              max={50}
              value={lev}
              onChange={(e) => setLev(Number(e.target.value))}
            />
            <div className="ta-chips">
              {[1, 5, 10, 25, 50].map((x) => (
                <button key={x} className={`ex-range${lev === x ? " is-on" : ""}`} onClick={() => setLev(x)}>
                  {x}x
                </button>
              ))}
            </div>
          </div>
          <dl className="ex-order-est">
            <div>
              <dt>Position size</dt>
              <dd>{usd(m * lev)}</dd>
            </div>
            <div>
              <dt>Fills at</dt>
              <dd>
                {side === "long" ? "Ask" : "Bid"}{" "}
                {fillAt ? fillAt.toLocaleString("en-US", { maximumFractionDigits: dp(market) }) : "…"}
              </dd>
            </div>
            <div>
              <dt>Liquidation</dt>
              <dd className="price-down">
                {liq ? `$${liq.toLocaleString("en-US", { maximumFractionDigits: dp(market) })}` : "…"}
              </dd>
            </div>
            <div>
              <dt>Fee</dt>
              <dd>None (play money)</dd>
            </div>
          </dl>
          <button
            className={`ex-order-cta is-${side === "long" ? "buy" : "sell"}`}
            disabled={stale || !!err}
            onClick={place}
          >
            {stale
              ? "Price feed paused · try again"
              : (err ?? `${side === "long" ? "Long" : "Short"} ${market} ${lev}x`)}
          </button>
          {orderMsg && <p className="ex-order-msg">{orderMsg}</p>}
          <p className="ex-order-note">
            {stale
              ? "Orders wait for a fresh price, so nothing fills at a stale one."
              : `Market orders fill at the live Hyperliquid bid/ask · up to 3 orders a second · ${MAX_OPEN} open positions max.`}
          </p>
          <span className="ta-mock-links">
            <button className="ta-mock-link" onClick={() => setPaused(!paused)}>
              (mockup: {paused ? "resume" : "pause"} the price feed)
            </button>
            <button className="ta-mock-link" onClick={() => (reset(), setOrderMsg(null))}>
              (reset my $10k)
            </button>
          </span>
        </section>
      </div>

      <section className="ex-card ex-positions-card ta-board">
        <div className="ta-board-head">
          <span className="ta-board-title">Your positions</span>
          <span className="ta-board-sub">
            {account.open.length} / {MAX_OPEN} open · Realized {usd(realized, true)} · {account.closed.length} closed{" "}
            {account.closed.length === 1 ? "trade" : "trades"}
          </span>
        </div>
        <table className="ta-table">
          <thead>
            <tr>
              <th>Market</th>
              <th>Side</th>
              <th>Size</th>
              <th>Entry</th>
              <th>Mark</th>
              <th>Liq.</th>
              <th>PnL</th>
              <th>Held</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {account.open.map((p) => {
              const k = p.market as PerpMarket;
              const mark = mids[k];
              const pnl = mark ? pnlAt(p, mark) : 0;
              const fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: dp(k) });
              return (
                <tr key={p.id}>
                  <td>{p.market}-PERP</td>
                  <td className={p.side === "long" ? "price-up" : "price-down"}>
                    {p.side === "long" ? "Long" : "Short"} {p.leverage}x
                  </td>
                  <td>{usd(p.margin * p.leverage)}</td>
                  <td className="ta-mono">{fmt(p.entry)}</td>
                  <td className="ta-mono">{mark ? fmt(mark) : "…"}</td>
                  <td className="ta-mono">{fmt(liqPrice(p.side, p.entry, p.leverage))}</td>
                  <td className={pnl >= 0 ? "price-up" : "price-down"}>
                    {usd(pnl, true)} <small>({((pnl / p.margin) * 100).toFixed(1)}%)</small>
                  </td>
                  <td className="ta-mono">{clock(Math.floor((Date.now() - p.openedAt) / 1000))}</td>
                  <td>
                    <button className="ex-range ta-close" disabled={!live[k]} onClick={() => close(p.id)}>
                      Close
                    </button>
                  </td>
                </tr>
              );
            })}
            {account.open.length === 0 && (
              <tr>
                <td colSpan={9} className="ta-empty">
                  No open positions
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Score({
  handle,
  label,
  pnl,
  balance,
  ahead,
}: {
  handle: string;
  label: string;
  pnl: number;
  balance: number;
  ahead: boolean;
}) {
  return (
    <div className={`ta-scorerow${ahead ? " is-ahead" : ""}`}>
      <Avatar handle={handle} pfp={null} size={36} />
      <span className="ta-score-names">
        <span className="ta-score-handle">@{handle}</span>
        <span className="ta-score-label">
          {label}
          {ahead && <i> · leading</i>}
        </span>
      </span>
      <span className="ta-score-nums">
        <span className={`ta-score-pnl ${pnl >= 0 ? "price-up" : "price-down"}`}>{usd(pnl, true)}</span>
        <span className="ta-score-bal">{usd(balance)}</span>
      </span>
    </div>
  );
}

function Meter({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="ta-meter">
      <span className="ta-meter-row">
        <span>{label}</span>
        <span className="ta-mono">{value}</span>
      </span>
      <span className="ta-meter-track">
        <span
          className={`ta-meter-fill${pct >= 1 ? " is-done" : ""}`}
          style={{ width: `${Math.min(1, pct) * 100}%` }}
        />
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ 5: result */

function Result({ wager, onAgain }: { wager: number; onAgain: () => void }) {
  const payout = wager * 2 * (1 - RAKE);
  return (
    <>
      <div className="ex-main ta-main ta-result">
        <section className="ex-card ta-result-main">
          <span className="ta-result-tag">Match over · 24:00:00</span>
          <h2 className="ta-result-title">You won</h2>
          <span className="ta-result-payout">+{fmtHype(payout)}</span>
          <span className="ta-result-sent">Sent to your Neuriio wallet when the match ended · tx 0x8f3a…c21e</span>
          <div className="ta-result-actions">
            <button className="ta-btn is-big" onClick={onAgain}>
              Play again · {fmtHype(wager)}
            </button>
            <button className="ta-btn is-ghost is-big">Share on X</button>
          </div>
        </section>
        <section className="ex-card ta-card-wrap">
          {/* the share card: @handle vs @handle (social exposure) */}
          <div className="ta-sharecard">
            <span className="ta-share-brand">Neuriio · Trade Arena</span>
            <div className="ta-share-row">
              <div className="ta-share-p is-win">
                <Avatar handle={ME} pfp={null} size={56} />
                <span>@{ME}</span>
                <b className="price-up">+12.84%</b>
                <small>14 trades · avg hold 11:20</small>
              </div>
              <span className="ta-share-vs">vs</span>
              <div className="ta-share-p">
                <Avatar handle={OPP} pfp={null} size={56} />
                <span>@{OPP}</span>
                <b className="price-down">−4.20%</b>
                <small>6 trades · avg hold 7:02</small>
              </div>
            </div>
            <span className="ta-share-foot">Won {fmtHype(payout)} · BTC · ETH perps · $10k each · 24h</span>
          </div>
        </section>
      </div>

      <section className="ex-card ex-positions-card ta-board">
        <div className="ta-board-head">
          <span className="ta-board-title">Final scores</span>
          <span className="ta-board-sub">Open positions were closed at the live price when the clock hit zero</span>
        </div>
        <table className="ta-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Final balance</th>
              <th>PnL</th>
              <th>Trades</th>
              <th>Avg hold</th>
              <th>Qualified</th>
              <th>Points</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>@{ME}</td>
              <td>$11,284.00</td>
              <td className="price-up">+$1,284.00</td>
              <td>14</td>
              <td className="ta-mono">11:20</td>
              <td>Yes</td>
              <td>+ TBD</td>
            </tr>
            <tr>
              <td>@{OPP}</td>
              <td>$9,580.00</td>
              <td className="price-down">−$420.00</td>
              <td>6</td>
              <td className="ta-mono">7:02</td>
              <td>Yes</td>
              <td>+ TBD</td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ wallet */

/** HYPE in the signed-in user's Neuriio wallet on Elysium (live, re-read every 10 s); null when logged out. */
function useWalletHype(): number | null {
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy");
  const { balances } = useBalances(wallet?.address as Address | undefined);
  if (!wallet || !balances) return null;
  return balances.elysium.tokens.find((t) => t.symbol === "HYPE")?.amount ?? 0;
}

/* ------------------------------------------------------------------ fake data helpers */

/** seconds since mount (when `on`) */
function useTicker(on: boolean) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setS((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [on]);
  return s;
}

function useCountdown(from: number) {
  const up = useTicker(true);
  return Math.max(0, from - up);
}

/** decimals shown for a market's price */
const dp = (k: PerpMarket) => (k === "BTC" ? 0 : 2);

const clock = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${two(h)}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
};
