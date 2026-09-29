// Explore, right column: buy/sell the picked token with the Neuriio (Privy) wallet.
//   curve tokens: Launchpad (0.75% fee), graduated: SwapRouter (0.25% fee). Quotes are exact on-chain previews
//   (price impact + fee); 1% slippage limit; sells approve the exact amount first. `?demo`: simulated wallet + trades.
import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatEther, parseEther, type Address, type EIP1193Provider } from "viem";
import { elysiumTestnet } from "../chain";
import { DEMO, type TokenStat } from "../lib/explore";
import { compactUsd } from "../lib/format";
import { SUPABASE_URL } from "../lib/config";
import { balances, friendlyTradeError, minOut, quote, SLIPPAGE_BPS, trade, type Side } from "../lib/trade";

const QUICK_BUY = ["0.1", "0.5", "1", "5"];
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
  const [bal, setBal] = useState<{ hype: bigint; tokens: bigint } | null>(null);
  const [q, setQ] = useState<{ out: bigint; refund: bigint } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [nonce, setNonce] = useState(0); // bump to refresh balances after a trade

  const amountIn = useMemo(() => {
    try {
      return amount ? parseEther(amount as `${number}`) : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);

  // balances
  useEffect(() => {
    if (!t || !account || !loggedIn) return setBal(null);
    if (DEMO) return setBal({ hype: parseEther("12.5"), tokens: parseEther("2500000") });
    let alive = true;
    const load = () => balances(account, t.address as Address).then((b) => alive && setBal(b), () => {});
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
        const r = DEMO ? demoQuote(t, side, amountIn) : await quote(t.address as Address, t.graduated, side, amountIn);
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

  const feeBps = t.graduated ? 25 : 75;
  const unitIn = side === "buy" ? "HYPE" : t.symbol;
  const unitOut = side === "buy" ? t.symbol : "HYPE";
  const have = bal ? (side === "buy" ? bal.hype : bal.tokens) : null;
  const tooMuch = have !== null && amountIn > have;
  const n = Number(amount) || 0;
  const usdValue = side === "buy" ? n * hypeUsd : n * t.price_hype * hypeUsd;
  // price impact vs the current spot price
  const spotOut = side === "buy" ? (n * (1 - feeBps / 10_000)) / t.price_hype : n * t.price_hype * (1 - feeBps / 10_000);
  const outNum = q ? Number(formatEther(q.out)) : 0;
  const impact = q && spotOut > 0 ? Math.max(0, (1 - outNum / spotOut) * 100) : null;
  const busy = status.kind === "busy";

  async function submit() {
    if (!t || !q || !account) return;
    setStatus({ kind: "busy", label: "Confirming…" });
    try {
      if (DEMO) {
        await new Promise((r) => setTimeout(r, 1200));
      } else {
        await wallet!.switchChain(elysiumTestnet.id);
        const provider = (await wallet!.getEthereumProvider()) as EIP1193Provider;
        await trade(
          provider,
          account,
          { token: t.address as Address, graduated: t.graduated, side, amountIn, minOut: minOut(q.out) },
          (s) => setStatus({ kind: "busy", label: s === "approving" ? "Approving…" : "Confirming…" }),
        );
      }
      // ask the indexer to store it now (stats, Top 25 volume); the live feed already shows it everywhere
      if (!DEMO) fetch(`${SUPABASE_URL}/functions/v1/indexer`, { method: "POST" }).catch(() => {});
      setStatus({ kind: "done", text: `${side === "buy" ? "Bought" : "Sold"} ${fmt(side === "buy" ? q.out : amountIn)} $${t.symbol}` });
      setAmount("");
      setNonce((x) => x + 1);
    } catch (e) {
      setStatus({ kind: "error", text: friendlyTradeError((e as Error).message) });
    }
  }

  let cta = `${side === "buy" ? "Buy" : "Sell"} @${t.handle}`;
  let disabled = busy;
  if (!loggedIn) cta = "Log in to trade";
  else if (busy) cta = status.label;
  else if (amountIn === 0n) (cta = "Enter an amount"), (disabled = true);
  else if (tooMuch) (cta = side === "buy" ? "Not enough HYPE" : `Not enough $${t.symbol}`), (disabled = true);
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
              Balance {fmt(have)} {unitIn}
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
          <dd>{q ? `${fmt(q.out)} ${unitOut}` : quoting ? "…" : "—"}</dd>
        </div>
        <div>
          <dt>Minimum ({Number(SLIPPAGE_BPS) / 100}% slippage)</dt>
          <dd>{q ? `${fmt(minOut(q.out))} ${unitOut}` : "—"}</dd>
        </div>
        <div>
          <dt>Price impact</dt>
          <dd className={impact !== null && impact > 5 ? "price-down" : undefined}>{impact !== null ? `${impact.toFixed(2)}%` : "—"}</dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>{(feeBps / 100).toFixed(2)}% {t.graduated ? "(pool)" : "(bonding curve)"}</dd>
        </div>
        {q && q.refund > 0n && (
          <div>
            <dt>Refunded (curve sells out)</dt>
            <dd>{fmt(q.refund)} HYPE</dd>
          </div>
        )}
      </dl>

      {status.kind === "done" && <p className="ex-order-msg price-up">{status.text}</p>}
      {status.kind === "error" && <p className="ex-order-msg price-down">{status.text}</p>}

      <button className={`ex-order-cta is-${side}`} disabled={disabled} onClick={loggedIn ? submit : login}>
        {cta}
      </button>
      <p className="ex-order-note">Tokens are memes with no promise of value.</p>
    </div>
  );
}

function fmt(wei: bigint) {
  const v = Number(formatEther(wei));
  return v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : v >= 1 ? 4 : 6 });
}

/** ?demo: spot price, fee and a simple price impact that grows with size. */
function demoQuote(t: TokenStat, side: Side, amountIn: bigint) {
  const n = Number(formatEther(amountIn));
  const fee = 1 - (t.graduated ? 25 : 75) / 10_000;
  const impact = 1 / (1 + n / (side === "buy" ? 150 : 150 / t.price_hype));
  const out = side === "buy" ? ((n * fee) / t.price_hype) * impact : n * t.price_hype * fee * impact;
  return { out: parseEther(out.toFixed(12) as `${number}`), refund: 0n };
}
