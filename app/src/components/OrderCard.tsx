// Explore, right column: buy/sell the picked token with the Neuriio (Privy) wallet, in USDC.
//   Every trade goes through the NeuriioRouter (curve or pool, 1% fee); quotes are exact on-chain previews (price
//   impact + fee); 1% slippage limit; one click = one transaction: the router's one-time approvals go out silently in
//   the background when the box opens (lib/trade.ts prepareTrading). `?demo`: simulated wallet + trades.
import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatEther, formatUnits, parseEther, parseUnits, type Address } from "viem";
import { DEMO, displayName, tickerOf, type TokenStat } from "../lib/explore";
import { compactUsd } from "../lib/format";
import { SUPABASE_URL } from "../lib/config";
import { balances, buyGraduates, FEE_BPS, friendlyTradeError, minOut, prepareTrading, quote, SLIPPAGE_BPS, trade, type Side } from "../lib/trade";
import { QUOTE } from "../lib/config";
import { GraduatingOverlay, ownGraduations, type GradStage } from "./GraduatingOverlay";
import { elysiumProvider } from "../lib/tx";

const QUICK_BUY = ["5", "25", "100", "250"]; // USDC
const QUICK_SELL = [25, 50, 75, 100];

type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "done"; text: string } | { kind: "error"; text: string };

export function OrderCard({ t, hypeUsd }: { t: TokenStat | null; hypeUsd: number }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy");
  const account = (DEMO ? "0x000000000000000000000000000000000000dE00" : wallet?.address) as Address | undefined;
  const loggedIn = DEMO || (ready && authenticated && !!wallet);

  const [side, setSide] = useState<Side>("buy");
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
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
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
      <div className="ex-order-tabs" role="tablist">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={side === s}
            className={`ex-order-tab is-${s}${side === s ? " is-on" : ""}`}
            onClick={() => {
              setSide(s);
              setAmount("");
              setStatus({ kind: "idle" });
            }}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

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

      <div className="ex-order-quick">
        {side === "buy"
          ? QUICK_BUY.map((v) => (
              <button key={v} className="ex-range" onClick={() => setAmount(v)}>
                {v}
              </button>
            ))
          : QUICK_SELL.map((pct) => (
              <button
                key={pct}
                className="ex-range"
                disabled={!bal || bal.tokens === 0n}
                onClick={() => bal && setAmount(formatEther((bal.tokens * BigInt(pct)) / 100n))}
              >
                {pct}%
              </button>
            ))}
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
          <dd>{(feeBps / 100).toFixed(2)}% {t.graduated ? "(pool)" : "(bonding curve)"}</dd>
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
