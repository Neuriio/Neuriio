// Explore, right column: buy/sell the picked token with the Neuriio (Privy) wallet, in USDC.
//   Every trade goes through the NeuriioRouter (curve or pool, 1% fee); quotes are exact on-chain previews (price
//   impact + fee); 1% slippage limit; one click = one transaction: the router's one-time approvals go out silently in
//   the background when the box opens (lib/trade.ts prepareTrading). `?demo`: simulated wallet + trades.
import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { Check, Pencil } from "lucide-react";
import { formatEther, formatUnits, parseEther, parseUnits, type Address } from "viem";
import { candles, DEMO, displayName, isOurs, tickerOf, type TokenStat } from "../lib/explore";
import { ftfCall } from "../lib/ftf";
import { compactUsd } from "../lib/format";
import { SUPABASE_URL } from "../lib/config";
import { balances, buyGraduates, FEE_BPS, friendlyTradeError, minOut, prepareTrading, quote, SLIPPAGE_BPS, trade, type Side } from "../lib/trade";
import { HYPE_SLIPPAGE_BPS, hypeBalances, hypeMinOut, hypeQuote, hypeTrade, swapPoolOf, type SwapPool } from "../lib/hypeSwap";
import { amount as fmtAmount } from "../lib/format";
import { QUOTE } from "../lib/config";
import { GraduatingOverlay, ownGraduations, type GradStage } from "./GraduatingOverlay";
import { elysiumProvider } from "../lib/tx";
import { TopHoldersCard } from "./TopHoldersCard"; // replaced LaunchCheckCard here (user, 2026-11-08); that card is kept
import { poll } from "../lib/poll";

const QUICK_BUY = ["5", "25", "100", "250"]; // USDC, until you set your own (the pencil)
const QUICK_KEY = "neuriio.quickBuy";

/** Your quick-buy amounts (USDC), remembered in this browser; the defaults if none or unreadable. */
function savedQuickBuy(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(QUICK_KEY) ?? "null");
    if (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "string" && Number(x) > 0)) return v;
  } catch {
    /* private window / blocked storage: defaults */
  }
  return QUICK_BUY;
}
const QUICK_SELL = [25, 50, 75, 100];

type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "done"; text: string } | { kind: "error"; text: string };

/** `fixedSide`: the parent's tabs pick buy or sell, so this card shows no tabs of its own. */
export function OrderCard({ t, hypeUsd, fixedSide }: { t: TokenStat | null; hypeUsd: number; fixedSide?: Side }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy");
  const account = (DEMO ? "0x000000000000000000000000000000000000dE00" : wallet?.address) as Address | undefined;
  const loggedIn = DEMO || (ready && authenticated && !!wallet);

  const [ownSide, setSide] = useState<Side>("buy");
  const side = fixedSide ?? ownSide;
  const [quick, setQuick] = useState<string[]>(savedQuickBuy);
  const [editing, setEditing] = useState<string[] | null>(null); // drafts while editing the quick amounts
  const [amount, setAmount] = useState("");
  const [bal, setBal] = useState<{ usdc: bigint; tokens: bigint; gas: bigint } | null>(null);
  const [q, setQ] = useState<{ out: bigint; refund: bigint; spot: number | null } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [nonce, setNonce] = useState(0); // bump to refresh balances after a trade
  const [grad, setGrad] = useState<GradStage>(null); // the full-page "Graduating" moment

  // buy: USDC (6 decimals); sell: the token (18)
  const amountIn = useMemo(() => {
    try {
      return amount ? (side === "buy" ? parseUnits(amount, QUOTE.decimals) : parseEther(amount as `${number}`)) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, side]);

  // a new side starts clean
  useEffect(() => {
    setAmount("");
    setStatus({ kind: "idle" });
  }, [side]);

  // balances
  useEffect(() => {
    if (!t || !account || !loggedIn) return setBal(null);
    if (DEMO) return setBal({ usdc: parseUnits("1250", QUOTE.decimals), tokens: parseEther("2500000"), gas: parseEther("0.2") });
    let alive = true;
    const load = () =>
      balances(account, t.address as Address).then((b) => {
        if (!alive) return;
        setBal(b);
        // approve the router in the background now, so the trade itself is one transaction
        if (wallet) prepareTrading(() => elysiumProvider(wallet), account, t.address as Address, b);
      }, () => {});
    const stop = poll(load, 60_000, { onChain: true });
    return () => {
      alive = false;
      stop();
    };
  }, [t?.address, account, loggedIn, nonce]);

  // exact quote as you type (debounced)
  useEffect(() => {
    setQ(null);
    if (!t || amountIn === 0n) return;
    let alive = true;
    setQuoting(true);
    const id = setTimeout(async () => {
      try {
        const r = DEMO ? demoQuote(t, side, amountIn) : await quote(t.address as Address, t.graduated, side, amountIn, t.launchpad);
        if (alive) setQ(r);
      } catch {
        if (alive) setQ(null);
      } finally {
        if (alive) setQuoting(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [t?.address, t?.graduated, side, amountIn]);

  if (!t) return <p className="ex-empty">Pick a token.</p>;
  // a token launched elsewhere (user, 2026-11-05/07): tradable in HYPE once NeuriioSwap approved its pool, else Owner Apply
  if (!isOurs(t)) return <OutsideToken key={t.address} t={t} fixedSide={fixedSide} />;

  const feeBps = FEE_BPS;
  const unitIn = side === "buy" ? QUOTE.symbol : tickerOf(t.symbol);
  const unitOut = side === "buy" ? tickerOf(t.symbol) : QUOTE.symbol;
  const have = bal ? (side === "buy" ? bal.usdc : bal.tokens) : null;
  const noGas = bal !== null && !DEMO && bal.gas === 0n;
  // amounts: what you pay in (side's unit) and what you get out (the other one)
  const fmtIn = (v: bigint) => (side === "buy" ? fmtUsdc(v) : fmt(v));
  const fmtOut = (v: bigint) => (side === "buy" ? fmt(v) : fmtUsdc(v));
  const tooMuch = have !== null && amountIn > have;
  const n = Number(amount) || 0;
  const usdValue = side === "buy" ? n * hypeUsd : n * t.price_hype * hypeUsd;
  // price impact: how far this trade's average price is from the on-chain spot price read with the quote (fee
  // excluded). Real, not slippage: "You receive" already includes it.
  const spot = q?.spot ?? t.price_hype;
  const spotOut = side === "buy" ? (n * (1 - feeBps / 10_000)) / spot : n * spot * (1 - feeBps / 10_000);
  const outNum = q ? Number(side === "buy" ? formatEther(q.out) : formatUnits(q.out, QUOTE.decimals)) : 0;
  const impact = q && spotOut > 0 ? Math.max(0, (1 - outNum / spotOut) * 100) : null;
  const busy = status.kind === "busy";

  /** Keeps the edited quick amounts (blank or zero ones fall back to what was there) and remembers them here. */
  function saveQuick() {
    if (!editing) return;
    const next = editing.map((v, i) => (Number(v) > 0 ? String(Number(v)) : quick[i]));
    setQuick(next);
    setEditing(null);
    try {
      localStorage.setItem(QUICK_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: they still apply until the page reloads */
    }
  }

  async function submit() {
    if (!t || !q || !account) return;
    setStatus({ kind: "busy", label: side === "buy" ? "Buying…" : "Selling…" });
    // does this buy take the curve's last tokens? (demo: any 250+ USDC buy on a curve token)
    const graduates =
      side === "buy" &&
      !t.graduated &&
      (DEMO ? amountIn >= parseUnits("250", QUOTE.decimals) : await buyGraduates(t.address as Address, q, t.launchpad).catch(() => false));
    if (graduates) ownGraduations.add(t.address.toLowerCase());
    try {
      if (DEMO) {
        if (graduates) setGrad("graduating");
        await new Promise((r) => setTimeout(r, graduates ? 3200 : 1200));
      } else {
        const provider = await elysiumProvider(wallet!);
        if (graduates) setGrad("graduating");
        await trade(provider, account, { token: t.address as Address, side, amountIn, minOut: minOut(q.out) });
      }
      if (graduates) {
        setGrad("graduated");
        setTimeout(() => setGrad(null), 2200);
      }
      // ask the indexer to store it now (stats, Top 25 volume); the live feed already shows it everywhere
      if (!DEMO) fetch(`${SUPABASE_URL}/functions/v1/indexer`, { method: "POST" }).catch(() => {});
      setStatus({ kind: "done", text: `${side === "buy" ? "Bought" : "Sold"} ${fmt(side === "buy" ? q.out : amountIn)} ${tickerOf(t.symbol)}` });
      setAmount("");
      setNonce((x) => x + 1);
    } catch (e) {
      setGrad(null);
      ownGraduations.delete(t.address.toLowerCase());
      setStatus({ kind: "error", text: friendlyTradeError((e as Error).message) });
    }
  }

  let cta = `${side === "buy" ? "Buy" : "Sell"} ${displayName(t)}`;
  let disabled = busy;
  if (!loggedIn) cta = "Log in to trade";
  else if (busy) cta = status.label;
  else if (amountIn === 0n) (cta = "Enter an amount"), (disabled = true);
  else if (tooMuch) (cta = side === "buy" ? `Not enough ${QUOTE.symbol}` : `Not enough ${tickerOf(t.symbol)}`), (disabled = true);
  else if (noGas) (cta = "Need a little HYPE for gas"), (disabled = true);
  else if (!q) (cta = quoting ? "Getting a quote…" : "No quote"), (disabled = true);

  return (
    <div className="ex-order">
      {!fixedSide && (
        <div className="ex-order-tabs" role="tablist">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={side === s}
              className={`ex-order-tab is-${s}${side === s ? " is-on" : ""}`}
              onClick={() => setSide(s)}
            >
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
      )}

      <label className="ex-order-field">
        <span className="ex-order-label-row">
          <span className="ex-order-label">Amount</span>
          {have !== null && (
            <span className="ex-order-bal">
              Balance {fmtIn(have)} {unitIn}
            </span>
          )}
        </span>
        <span className="ex-order-input">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"));
              setStatus({ kind: "idle" });
            }}
          />
          <span className="ex-order-unit">{unitIn}</span>
        </span>
        <span className="ex-order-sub">{n > 0 && hypeUsd ? `≈ ${compactUsd(usdValue)}` : " "}</span>
      </label>

      <div className={`ex-order-quick${side === "buy" ? " has-edit" : ""}`}>
        {side === "buy" && editing ? (
          <>
            {editing.map((v, i) => (
              <input
                key={i}
                className="ex-range ex-quick-input"
                inputMode="decimal"
                value={v}
                aria-label={`Quick amount ${i + 1} (USDC)`}
                autoFocus={i === 0}
                onChange={(e) => setEditing(editing.map((x, j) => (j === i ? e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1") : x)))}
                onKeyDown={(e) => e.key === "Enter" && saveQuick()}
              />
            ))}
            <button className="ex-range ex-quick-edit" onClick={saveQuick} aria-label="Save quick amounts" title="Save">
              <Check size={13} />
            </button>
          </>
        ) : side === "buy" ? (
          <>
            {quick.map((v, i) => (
              <button key={i} className="ex-range" onClick={() => setAmount(v)}>
                {v}
              </button>
            ))}
            <button className="ex-range ex-quick-edit" onClick={() => setEditing(quick)} aria-label="Edit quick amounts" title="Edit amounts">
              <Pencil size={12} />
            </button>
          </>
        ) : (
          QUICK_SELL.map((pct) => (
              <button
                key={pct}
                className="ex-range"
                disabled={!bal || bal.tokens === 0n}
                onClick={() => bal && setAmount(formatEther((bal.tokens * BigInt(pct)) / 100n))}
              >
                {pct}%
              </button>
            ))
        )}
      </div>

      <dl className="ex-order-est">
        <div>
          <dt>You receive</dt>
          <dd>{q ? `${fmtOut(q.out)} ${unitOut}` : quoting ? "…" : "—"}</dd>
        </div>
        <div>
          <dt>Minimum ({Number(SLIPPAGE_BPS) / 100}% slippage)</dt>
          <dd>{q ? `${fmtOut(minOut(q.out))} ${unitOut}` : "—"}</dd>
        </div>
        <div>
          <dt title="How much this trade moves the price. You still receive the amount shown above.">Price impact</dt>
          <dd
            className={impact === null ? undefined : impact > 5 ? "price-down" : impact >= 1 ? "impact-mid" : undefined}
            title="How much this trade moves the price. You still receive the amount shown above."
          >
            {impact !== null ? `${impact < 0.01 && impact > 0 ? "<0.01" : impact.toFixed(2)}%` : "—"}
          </dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>0% (Ascend Fees)</dd>
        </div>
        {q && q.refund > 0n && (
          <div>
            <dt>Refunded (curve sells out)</dt>
            <dd>{fmtUsdc(q.refund)} {QUOTE.symbol}</dd>
          </div>
        )}
      </dl>

      {status.kind === "done" && <p className="ex-order-msg price-up">{status.text}</p>}
      {status.kind === "error" && <p className="ex-order-msg price-down">{status.text}</p>}

      <button className={`ex-order-cta is-${side}`} disabled={disabled} onClick={loggedIn ? submit : login}>
        {cta}
      </button>
      <p className="ex-order-note">Tokens are memes with no promise of value.</p>
      <TradeBars address={t.address} nonce={nonce} creator={t.creator} />
      <GraduatingOverlay stage={grad} name={displayName(t)} />
    </div>
  );
}

function fmt(wei: bigint) {
  const v = Number(formatEther(wei));
  return v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : v >= 1 ? 4 : 6 });
}

/** USDC: cents (more digits only for dust). */
function fmtUsdc(units: bigint) {
  const v = Number(formatUnits(units, QUOTE.decimals));
  return v.toLocaleString("en-US", { minimumFractionDigits: v >= 0.01 || v === 0 ? 2 : 0, maximumFractionDigits: v >= 0.01 || v === 0 ? 2 : 6 });
}

/** ?demo: spot price, fee and a simple price impact that grows with size (USDC in, tokens out, or back). */
function demoQuote(t: TokenStat, side: Side, amountIn: bigint) {
  const n = Number(side === "buy" ? formatUnits(amountIn, QUOTE.decimals) : formatEther(amountIn));
  const fee = 1 - FEE_BPS / 10_000;
  const impact = 1 / (1 + n / (side === "buy" ? 6_000 : 6_000 / t.price_hype));
  const out = side === "buy" ? ((n * fee) / t.price_hype) * impact : n * t.price_hype * fee * impact;
  return {
    out: side === "buy" ? parseEther(out.toFixed(12) as `${number}`) : parseUnits(out.toFixed(QUOTE.decimals), QUOTE.decimals),
    refund: 0n,
    spot: t.price_hype,
  };
}

const BAR_DAYS = 7;

/** Under the order box: this token's daily volume, last 7 days, from the stored 4H candles (refreshes after your own trade and every
 *  minute), then the Launch check. */
/** `elsewhere`: a coin launched elsewhere on Ascend (its candles come from our indexer like ours; only the launch check differs). */
function TradeBars({ address, nonce, elsewhere, creator }: { address: string; nonce: number; elsewhere?: boolean; creator?: string | null }) {
  const [days, setDays] = useState<{ day: string; vol: number }[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      candles(address, 14400, BAR_DAYS * 6).then((cs) => {
        const byDay = new Map<string, number>();
        for (let i = BAR_DAYS - 1; i >= 0; i--) byDay.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), 0);
        for (const c of cs) {
          const d = new Date(c.bucket).toISOString().slice(0, 10);
          if (byDay.has(d)) byDay.set(d, byDay.get(d)! + (c.volume_usd ?? c.volume_hype));
        }
        if (alive) setDays([...byDay].map(([day, vol]) => ({ day, vol })));
      }, () => {});
    const stop = poll(load, 60_000);
    return () => {
      alive = false;
      stop();
    };
  }, [address, nonce, elsewhere]);
  return (
    <div className="ex-bars">
      <BarCard title="Volume" unit="7d" values={days?.map((d) => ({ day: d.day, v: d.vol })) ?? null} />
      <TopHoldersCard address={address} creator={creator} />
    </div>
  );
}

function BarCard({ title, unit, values }: { title: string; unit: string; values: { day: string; v: number }[] | null }) {
  // left to right from the first day with trades (a new token's bars start at the left edge)
  const first = (values ?? []).findIndex((x) => x.v > 0);
  const shown = first < 0 ? [] : values!.slice(first);
  const total = shown.reduce((a, x) => a + x.v, 0);
  const top = niceMax(Math.max(...shown.map((x) => x.v), 0));
  return (
    <div className="ex-bars-card">
      <div className="ex-bars-head">
        <span>
          {title} · {unit}
        </span>
        <b>{values ? compactUsd(total) : "…"}</b>
      </div>
      <div className="ex-bars-chart">
        <div className="ex-bars-plot">
          {shown.map((x) => (
            <span
              key={x.day}
              className="ex-bar"
              style={{ height: top > 0 ? `${Math.max(x.v > 0 ? 3 : 0, (x.v / top) * 100)}%` : 0 }}
              title={`${x.day}: ${compactUsd(x.v)}`}
            />
          ))}
        </div>
        <div className="ex-bars-axis" aria-hidden>
          {[top, (top * 2) / 3, top / 3, 0].map((v, i) => (
            <span key={i}>{top > 0 ? compactUsd(v) : i === 3 ? "$0" : ""}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A round number at or above `v` (1, 1.5, 3, 6 × 10^n), so the axis labels read cleanly in thirds. */
function niceMax(v: number) {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.5, 3, 6, 10].find((m) => m * p >= v) ?? 10) * p;
}

/** A coin launched elsewhere on Ascend (user, 2026-11-05): "Token Not Tradable", and "Apply For Trading", which puts a request in
 *  the trading admins' notifications (the ftf function's applyTrading; one open request per user per coin). */
export function NotTradable({ t }: { t: TokenStat }) {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  const [state, setState] = useState<"idle" | "busy" | "applied">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setState("idle");
    setError(null);
  }, [t.address]);
  const apply = async () => {
    if (!authenticated) return login();
    setState("busy");
    setError(null);
    try {
      await ftfCall(getAccessToken, "applyTrading", { token: t.address });
      setState("applied");
    } catch (e) {
      setState("idle");
      setError((e as Error).message);
    }
  };
  return (
    <div className="ex-not-tradable">
      <p className="ex-not-tradable-title">Token Not Tradable</p>
      <button className="lock-login ex-apply" disabled={!ready || state !== "idle"} onClick={apply}>
        {state === "applied" ? (
          <>
            <Check size={13} strokeWidth={3} /> Applied
          </>
        ) : state === "busy" ? (
          "Applying…"
        ) : (
          "Owner Apply" // user, 2026-11-06: makes clear it's for the token's owner, not everyone
        )}
      </button>
      {state === "applied" && <p className="ex-order-note">Thanks. The Neuriio team has your request.</p>}
      {error && <p className="lp-warn">{error}</p>}
    </div>
  );
}

/** A token launched elsewhere: the HYPE trade box when NeuriioSwap trades its pool (user, 2026-11-07), else "Token Not
 *  Tradable" with Owner Apply. */
function OutsideToken({ t, fixedSide }: { t: TokenStat; fixedSide?: Side }) {
  const [pool, setPool] = useState<SwapPool | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    swapPoolOf(t.address as Address).then((p) => alive && setPool(p));
    return () => {
      alive = false;
    };
  }, [t.address]);
  if (pool === undefined) return <p className="ex-empty">…</p>;
  // not tradable here yet: still show its Volume and Launch check (they don't depend on trading)
  if (!pool)
    return (
      <>
        <NotTradable t={t} />
        <TradeBars address={t.address} nonce={0} elsewhere creator={t.creator} />
      </>
    );
  return <HypeOrderCard t={t} pool={pool} fixedSide={fixedSide} />;
}

const HYPE_QUICK = ["0.1", "0.5", "1", "5"];
const PAIR_QUICK = ["5", "10", "25", "100"]; // a non-HYPE pair, e.g. USDC

/** Buy with HYPE / sell for HYPE through NeuriioSwap: the token's own pool (its launchpad's fee) plus our 0.5%. */
function HypeOrderCard({ t, pool, fixedSide }: { t: TokenStat; pool: SwapPool; fixedSide?: Side }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy");
  const account = wallet?.address as Address | undefined;
  const loggedIn = ready && authenticated && !!wallet;
  const [ownSide, setSide] = useState<Side>("buy");
  const side = fixedSide ?? ownSide;
  const [amount, setAmount] = useState("");
  const [bal, setBal] = useState<{ pay: bigint; tokens: bigint; gas: bigint } | null>(null);
  const [out, setOut] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [nonce, setNonce] = useState(0);
  const unitIn = side === "buy" ? pool.symbol : tickerOf(t.symbol);
  const unitOut = side === "buy" ? tickerOf(t.symbol) : pool.symbol;
  const decIn = side === "buy" ? pool.decimals : 18; // Ascend and Montra tokens have 18 decimals
  const decOut = side === "buy" ? 18 : pool.decimals;
  const venue = "Ascend";

  const amountIn = useMemo(() => {
    try {
      return amount ? parseUnits(amount, decIn) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, decIn]);

  useEffect(() => {
    setAmount("");
    setStatus({ kind: "idle" });
  }, [side]);

  useEffect(() => {
    if (!account) return setBal(null);
    let alive = true;
    hypeBalances(account, t.address as Address, pool).then((b) => alive && setBal(b), () => {});
    return () => {
      alive = false;
    };
  }, [account, t.address, nonce]);

  useEffect(() => {
    setOut(null);
    if (amountIn === 0n) return;
    let alive = true;
    setQuoting(true);
    const id = setTimeout(() => {
      hypeQuote(pool, side, amountIn)
        .then((o) => alive && setOut(o), () => alive && setOut(null))
        .finally(() => alive && setQuoting(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [pool, side, amountIn]);

  const have = bal ? (side === "buy" ? bal.pay : bal.tokens) : null;
  const gasReserve = parseEther("0.001");
  const tooMuch = have !== null && (side === "buy" && pool.inHype ? amountIn + gasReserve > have : amountIn > have);
  const noGas = bal !== null && bal.gas === 0n;
  const fmtIn = (v: bigint) => fmtAmount(Number(formatUnits(v, decIn)));
  const fmt = (v: bigint) => fmtAmount(Number(formatUnits(v, decOut)));

  async function submit() {
    if (!wallet || !account || !out) return;
    setStatus({ kind: "busy", label: side === "buy" ? "Buying…" : "Selling…" });
    try {
      const provider = await elysiumProvider(wallet);
      await hypeTrade(provider, account, pool, { token: t.address as Address, side, amountIn, minOut: hypeMinOut(out) });
      setStatus({ kind: "done", text: side === "buy" ? `Bought ${fmt(out)} ${unitOut}` : `Sold for ${fmt(out)} ${unitOut}` });
      setAmount("");
      setNonce((n) => n + 1);
    } catch (e) {
      setStatus({ kind: "error", text: friendlyTradeError((e as Error).message) });
    }
  }

  let cta = side === "buy" ? `Buy ${tickerOf(t.symbol)}` : `Sell ${tickerOf(t.symbol)}`;
  let disabled = false;
  if (!loggedIn) cta = "Log in to trade";
  else if (status.kind === "busy") (cta = status.label), (disabled = true);
  else if (amountIn === 0n) disabled = true;
  else if (noGas) (cta = "You need a little HYPE for gas"), (disabled = true);
  else if (tooMuch) (cta = side === "buy" && pool.inHype ? "Not enough HYPE (keep some for gas)" : "Not enough balance"), (disabled = true);
  else if (!out) (cta = quoting ? "Getting a quote…" : "No quote"), (disabled = true);

  return (
    <div className="ex-order">
      {!fixedSide && (
        <div className="ex-order-tabs" role="tablist">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={side === s} className={`ex-order-tab is-${s}${side === s ? " is-on" : ""}`} onClick={() => setSide(s)}>
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
      )}
      <label className="ex-order-field">
        <span className="ex-order-label-row">
          <span className="ex-order-label">Amount</span>
          {have !== null && (
            <span className="ex-order-bal">
              Balance {fmtIn(have)} {unitIn}
            </span>
          )}
        </span>
        <span className="ex-order-input">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"));
              setStatus({ kind: "idle" });
            }}
          />
          <span className="ex-order-unit">{unitIn}</span>
        </span>
        <span className="ex-order-sub"> </span>
      </label>
      <div className="ex-order-quick">
        {side === "buy"
          ? (pool.inHype ? HYPE_QUICK : PAIR_QUICK).map((v) => (
              <button key={v} className="ex-range" onClick={() => setAmount(v)}>
                {v}
              </button>
            ))
          : QUICK_SELL.map((pct) => (
              <button key={pct} className="ex-range" disabled={!bal || bal.tokens === 0n} onClick={() => bal && setAmount(formatEther((bal.tokens * BigInt(pct)) / 100n))}>
                {pct}%
              </button>
            ))}
      </div>
      <dl className="ex-order-est">
        <div>
          <dt>You receive</dt>
          <dd>{out ? `${fmt(out)} ${unitOut}` : quoting ? "…" : "—"}</dd>
        </div>
        <div>
          <dt>Minimum ({Number(HYPE_SLIPPAGE_BPS) / 100}% slippage)</dt>
          <dd>{out ? `${fmt(hypeMinOut(out))} ${unitOut}` : "—"}</dd>
        </div>
        <div>
          <dt title={`${venue}'s own fee is inside the quote; Neuriio adds 0.5%`}>Fee</dt>
          <dd title={`${venue}'s own fee is inside the quote; Neuriio adds 0.5%`}>{venue} + 0.5%</dd>
        </div>
      </dl>
      {status.kind === "done" && <p className="ex-order-msg price-up">{status.text}</p>}
      {status.kind === "error" && <p className="ex-order-msg price-down">{status.text}</p>}
      <button className={`ex-order-cta is-${side}`} disabled={disabled} onClick={loggedIn ? submit : login}>
        {cta}
      </button>
      <TradeBars address={t.address} nonce={nonce} elsewhere creator={t.creator} />
    </div>
  );
}
