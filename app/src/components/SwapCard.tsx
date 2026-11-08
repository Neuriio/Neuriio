// /swap (user, 2026-11-05; replaced /trending): one swap card, "You pay" / "You receive", each with a token picker.
// Tokens on offer (user, 2026-11-08): only HYPE (Elysium's gas token), USDC and KNTQ, with their own logos in public/tokens/
// (HYPE: Hyperliquid's mark; USDC: Circle's icon as Hyperliquid serves it; KNTQ: Kinetiq's icon from CoinGecko).
// Wired 2026-11-08 (user): straight through Elysium's Uniswap v4 pools (lib/swap.ts, swapRoute.ts), no fee of ours for now.
// The pools are thin, so the card shows the price impact and warns past 5%.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { ArrowDownUp, ChevronDown, Search, X } from "lucide-react";
import { erc20Abi, formatUnits, parseEther, parseUnits, type Address } from "viem";
import { Avatar } from "./Avatar";
import { ELYSIUM_TOKENS, QUOTE } from "../lib/config";
import { pub } from "../lib/launch";
import { amount as fmtAmount } from "../lib/format";
import { quoteSwap, sendSwap, SWAP_SLIPPAGE_BPS, swapMinOut, swapRoute } from "../lib/swap";
import { friendlyTradeError } from "../lib/trade";
import { elysiumProvider } from "../lib/tx";

type SwapToken = { address: Address | "native"; symbol: string; name: string; decimals: number; pfp: string | null };

const HYPE: SwapToken = { address: "native", symbol: "HYPE", name: "HYPE", decimals: 18, pfp: "/tokens/hype.svg" };
const USDC: SwapToken = { address: QUOTE.address, symbol: "USDC", name: "USD Coin", decimals: QUOTE.decimals, pfp: "/tokens/usdc.svg" };
const kntq = ELYSIUM_TOKENS.find((t) => t.symbol === "KNTQ")!;
const KNTQ: SwapToken = { address: kntq.address, symbol: "KNTQ", name: "Kinetiq", decimals: kntq.decimals, pfp: "/tokens/kntq.png" };
const TOKENS = [HYPE, USDC, KNTQ];
const GAS_RESERVE = parseEther("0.001"); // left in the wallet when paying with HYPE
const IMPACT_WARN = 0.05;

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string };

/** A wallet's balance of a token, in base units (null while unknown); re-read when `nonce` changes. */
function useBalance(wallet: Address | undefined, token: SwapToken, nonce: number) {
  const [bal, setBal] = useState<bigint | null>(null);
  useEffect(() => {
    setBal(null);
    if (!wallet) return;
    let alive = true;
    const read =
      token.address === "native"
        ? pub.getBalance({ address: wallet })
        : pub.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
    read.then((b) => alive && setBal(b), () => {});
    return () => {
      alive = false;
    };
  }, [wallet, token.address, nonce]);
  return bal;
}

export function SwapCard() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const privy = authenticated ? wallets.find((w) => w.walletClientType === "privy") : undefined;
  const wallet = privy?.address as Address | undefined;

  const [pay, setPay] = useState<SwapToken>(USDC);
  const [receive, setReceive] = useState<SwapToken>(HYPE);
  const [amountIn, setAmountIn] = useState("");
  const [picking, setPicking] = useState<"pay" | "receive" | null>(null);
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [q, setQ] = useState<{ out: bigint; impact: number | null } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const payBal = useBalance(wallet, pay, nonce);
  const receiveBal = useBalance(wallet, receive, nonce);
  const gas = useBalance(wallet, HYPE, nonce);

  const hops = useMemo(() => swapRoute(pay.address, receive.address), [pay.address, receive.address]);
  const amount = useMemo(() => {
    try {
      return amountIn ? parseUnits(amountIn, pay.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amountIn, pay.decimals]);

  useEffect(() => {
    setQ(null);
    if (!hops || amount === 0n) return;
    let alive = true;
    setQuoting(true);
    const id = setTimeout(() => {
      quoteSwap(hops, amount, pay.decimals, receive.decimals)
        .then((r) => alive && setQ(r), () => alive && setQ(null))
        .finally(() => alive && setQuoting(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [hops, amount, pay.decimals, receive.decimals, nonce]);

  const edit = (v: string) => {
    setAmountIn(v);
    setStatus({ kind: "idle" });
  };
  const flip = () => {
    setPay(receive);
    setReceive(pay);
    edit("");
  };
  const choose = (t: SwapToken) => {
    const side = picking;
    setPicking(null);
    if (side === "pay") {
      if (t.address === receive.address) setReceive(pay);
      setPay(t);
    } else if (side === "receive") {
      if (t.address === pay.address) setPay(receive);
      setReceive(t);
    }
    edit("");
  };
  const useMax = () => {
    if (payBal === null) return;
    const max = pay.address === "native" ? (payBal > GAS_RESERVE ? payBal - GAS_RESERVE : 0n) : payBal;
    edit(formatUnits(max, pay.decimals));
  };

  async function submit() {
    if (!privy || !wallet || !hops || !q) return;
    setStatus({ kind: "busy" });
    try {
      await sendSwap(await elysiumProvider(privy), wallet, hops, amount, swapMinOut(q.out));
      setStatus({ kind: "done", text: `Swapped ${fmtUnits(amount, pay.decimals)} ${pay.symbol} for ${fmtUnits(q.out, receive.decimals)} ${receive.symbol}` });
      setAmountIn("");
      setNonce((n) => n + 1);
    } catch (e) {
      setStatus({ kind: "error", text: friendlyTradeError((e as Error).message) });
    }
  }

  const tooMuch = payBal !== null && (pay.address === "native" ? amount + GAS_RESERVE > payBal : amount > payBal);
  const noGas = gas !== null && gas === 0n;
  const button = !ready
    ? { label: "Loading…", disabled: true, onClick: undefined }
    : !authenticated
      ? { label: "Log in to swap", disabled: false, onClick: login }
      : status.kind === "busy"
        ? { label: "Swapping…", disabled: true, onClick: undefined }
        : !hops
          ? { label: "No route for this pair", disabled: true, onClick: undefined }
          : amount === 0n
            ? { label: "Enter an amount", disabled: true, onClick: undefined }
            : noGas
              ? { label: "You need a little HYPE for gas", disabled: true, onClick: undefined }
              : tooMuch
                ? { label: pay.address === "native" ? "Not enough HYPE (keep some for gas)" : `Not enough ${pay.symbol}`, disabled: true, onClick: undefined }
                : !q
                  ? { label: quoting ? "Getting a quote…" : "Not enough liquidity", disabled: true, onClick: undefined }
                  : { label: "Swap", disabled: false, onClick: submit };
  const highImpact = q?.impact != null && q.impact > IMPACT_WARN;

  return (
    <section className="panel sw-card">
      <header className="sw-head">
        <span className="sw-title">Swap</span>
        <span className="sw-net">Elysium</span>
      </header>

      <div className="sw-box">
        <div className="sw-box-top">
          <span>You pay</span>
          {payBal !== null && (
            <button className="sw-max" onClick={useMax} title={pay.address === "native" ? "Your whole balance, less a little for gas" : "Use your whole balance"}>
              Balance {fmtUnits(payBal, pay.decimals)}
            </button>
          )}
        </div>
        <div className="sw-box-row">
          <input
            className="sw-input"
            inputMode="decimal"
            placeholder="0"
            value={amountIn}
            onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && edit(e.target.value)}
            aria-label={`Amount of ${pay.symbol} to pay`}
          />
          <TokenButton t={pay} onClick={() => setPicking("pay")} />
        </div>
      </div>

      <button className="sw-flip" aria-label="Swap the two tokens" onClick={flip}>
        <ArrowDownUp size={15} />
      </button>

      <div className="sw-box">
        <div className="sw-box-top">
          <span>You receive</span>
          {receiveBal !== null && <span>Balance {fmtUnits(receiveBal, receive.decimals)}</span>}
        </div>
        <div className="sw-box-row">
          <span className={`sw-output${q ? " is-set" : ""}`}>{q ? fmtUnits(q.out, receive.decimals) : quoting ? "…" : "—"}</span>
          <TokenButton t={receive} onClick={() => setPicking("receive")} />
        </div>
      </div>

      {q && (
        <dl className="sw-details">
          <div>
            <dt>Rate</dt>
            <dd>
              1 {pay.symbol} = {fmtAmount(Number(formatUnits(q.out, receive.decimals)) / Number(formatUnits(amount, pay.decimals)))} {receive.symbol}
            </dd>
          </div>
          <div>
            <dt>Minimum ({Number(SWAP_SLIPPAGE_BPS) / 100}% slippage)</dt>
            <dd>
              {fmtUnits(swapMinOut(q.out), receive.decimals)} {receive.symbol}
            </dd>
          </div>
          {q.impact !== null && (
            <div>
              <dt>Price impact</dt>
              <dd className={highImpact ? "price-down" : undefined}>{(q.impact * 100).toFixed(2)}%</dd>
            </div>
          )}
          <div>
            <dt>Route</dt>
            <dd>{hops && hops.length > 1 ? `${pay.symbol} → USDC → ${receive.symbol}` : `${pay.symbol} → ${receive.symbol}`}</dd>
          </div>
        </dl>
      )}
      {highImpact && <p className="sw-warn">This pool is thin: a smaller amount gets a better rate.</p>}
      {hops && amount > 0n && !q && !quoting && <p className="sw-warn">Not enough liquidity in the pool for this amount. Try a smaller one.</p>}
      {status.kind === "done" && <p className="sw-msg price-up">{status.text}</p>}
      {status.kind === "error" && <p className="sw-msg price-down">{status.text}</p>}

      <button className="lock-login sw-go" disabled={button.disabled} onClick={button.onClick}>
        {button.label}
      </button>

      {picking && <TokenPicker tokens={TOKENS} onPick={choose} onClose={() => setPicking(null)} />}
    </section>
  );
}

/** Whole units, readable. */
function fmtUnits(v: bigint, decimals: number) {
  return fmtAmount(Number(formatUnits(v, decimals)));
}

function TokenButton({ t, onClick }: { t: SwapToken; onClick: () => void }) {
  return (
    <button className="sw-token" onClick={onClick}>
      <Avatar handle={t.symbol} pfp={t.pfp} size={22} className="sw-logo" />
      <span>{t.symbol}</span>
      <ChevronDown size={14} />
    </button>
  );
}

function TokenPicker({ tokens, onPick, onClose }: { tokens: SwapToken[]; onPick: (t: SwapToken) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const needle = q.trim().toLowerCase().replace(/^\$/, "");
  const shown = tokens.filter((t) => !needle || t.symbol.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle) || (t.address !== "native" && t.address.toLowerCase() === needle));
  return createPortal(
    <div className="nt-backdrop" onClick={onClose}>
      <div className="nt-modal sw-picker" role="dialog" aria-modal="true" aria-label="Pick a token" onClick={(e) => e.stopPropagation()}>
        <header className="nt-head">
          <span className="nt-title">Pick a token</span>
          <button className="ex-modal-close" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <label className="ex-search sw-search">
          <Search size={15} aria-hidden />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ticker or address" />
        </label>
        <ul className="sw-list">
          {shown.map((t) => (
            <li key={t.address}>
              <button className="sw-row" onClick={() => onPick(t)}>
                <Avatar handle={t.symbol} pfp={t.pfp} size={28} className="sw-logo" />
                <span className="sw-row-names">
                  <span className="sw-row-symbol">{t.symbol}</span>
                  <span className="sw-row-name">{t.name}</span>
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="nt-empty">No token matches.</li>}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
