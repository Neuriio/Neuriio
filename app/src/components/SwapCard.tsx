// /swap (user, 2026-11-05; replaced /trending): one swap card, "You pay" / "You receive", each with a token picker. It will route
// through a DEX aggregator contract (Ascend's; config SWAP_AGGREGATOR). Until that address is set the card shows real tokens and
// your real balances, but no quotes, and its Swap button stays off: nothing here is sample data.
// Tokens on offer: HYPE (Elysium's gas token), USDC, and Explore's Trending list (Agora's top 15 by 24h volume).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { ArrowDownUp, ChevronDown, Search, X } from "lucide-react";
import { erc20Abi, formatUnits, type Address } from "viem";
import { Avatar } from "./Avatar";
import { QUOTE, SWAP_AGGREGATOR } from "../lib/config";
import { pub } from "../lib/launch";
import { agoraTrending, displayName, type TokenStat } from "../lib/explore";
import { amount as fmtAmount, compactUsd } from "../lib/format";

type SwapToken = { address: Address | "native"; symbol: string; name: string; decimals: number; pfp: string | null };

const HYPE: SwapToken = { address: "native", symbol: "HYPE", name: "HYPE", decimals: 18, pfp: null };
const USDC: SwapToken = { address: QUOTE.address, symbol: "USDC", name: "USD Coin", decimals: QUOTE.decimals, pfp: null };

const fromStat = (t: TokenStat): SwapToken => ({
  address: t.address as Address,
  symbol: (t.symbol ?? t.handle).toUpperCase(),
  name: displayName(t),
  decimals: 18, // Ascend coins are standard 18-decimal ERC-20s
  pfp: t.x_pfp_url,
});

/** A wallet's balance of a token, in whole units (null while unknown). */
function useBalance(wallet: Address | undefined, token: SwapToken) {
  const [bal, setBal] = useState<number | null>(null);
  useEffect(() => {
    setBal(null);
    if (!wallet) return;
    let alive = true;
    const read =
      token.address === "native"
        ? pub.getBalance({ address: wallet })
        : pub.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
    read.then((b) => alive && setBal(Number(formatUnits(b, token.decimals))), () => {});
    return () => {
      alive = false;
    };
  }, [wallet, token.address, token.decimals]);
  return bal;
}

export function SwapCard() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = authenticated ? (wallets.find((w) => w.walletClientType === "privy")?.address as Address | undefined) : undefined;

  const [list, setList] = useState<TokenStat[]>([]);
  useEffect(() => {
    agoraTrending().then(setList, () => {});
  }, []);

  const [pay, setPay] = useState<SwapToken>(USDC);
  const [receive, setReceive] = useState<SwapToken>(HYPE);
  const [amountIn, setAmountIn] = useState("");
  const [picking, setPicking] = useState<"pay" | "receive" | null>(null);
  const payBal = useBalance(wallet, pay);
  const receiveBal = useBalance(wallet, receive);

  const flip = () => {
    setPay(receive);
    setReceive(pay);
    setAmountIn("");
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
  };

  const typed = Number(amountIn);
  const tooMuch = payBal !== null && typed > payBal;
  const button = !ready
    ? { label: "Loading…", disabled: true, onClick: undefined }
    : !authenticated
      ? { label: "Log in to swap", disabled: false, onClick: login }
      : !SWAP_AGGREGATOR
        ? { label: "Swaps open soon", disabled: true, onClick: undefined }
        : !(typed > 0)
          ? { label: "Enter an amount", disabled: true, onClick: undefined }
          : tooMuch
            ? { label: `Not enough ${pay.symbol}`, disabled: true, onClick: undefined }
            : { label: "Swap", disabled: true, onClick: undefined }; // the aggregator call is wired once its address and ABI are in

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
            <button className="sw-max" onClick={() => setAmountIn(String(payBal))} title="Use your whole balance">
              Balance {fmtAmount(payBal)}
            </button>
          )}
        </div>
        <div className="sw-box-row">
          <input
            className="sw-input"
            inputMode="decimal"
            placeholder="0"
            value={amountIn}
            onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setAmountIn(e.target.value)}
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
          {receiveBal !== null && <span>Balance {fmtAmount(receiveBal)}</span>}
        </div>
        <div className="sw-box-row">
          <span className="sw-output" title={SWAP_AGGREGATOR ? undefined : "Quotes start once the swap aggregator is connected"}>
            —
          </span>
          <TokenButton t={receive} onClick={() => setPicking("receive")} />
        </div>
      </div>

      <button className="lock-login sw-go" disabled={button.disabled} onClick={button.onClick}>
        {button.label}
      </button>
      {!SWAP_AGGREGATOR && <p className="sw-note">Quotes and swaps start once the swap aggregator is connected.</p>}

      {picking && (
        <TokenPicker
          tokens={[HYPE, USDC, ...list.map(fromStat)]}
          stats={list}
          onPick={choose}
          onClose={() => setPicking(null)}
        />
      )}
    </section>
  );
}

function TokenButton({ t, onClick }: { t: SwapToken; onClick: () => void }) {
  return (
    <button className="sw-token" onClick={onClick}>
      <Avatar handle={t.symbol} pfp={t.pfp} size={22} />
      <span>{t.symbol}</span>
      <ChevronDown size={14} />
    </button>
  );
}

function TokenPicker({ tokens, stats, onPick, onClose }: { tokens: SwapToken[]; stats: TokenStat[]; onPick: (t: SwapToken) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const needle = q.trim().toLowerCase().replace(/^\$/, "");
  const shown = tokens.filter((t) => !needle || t.symbol.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle) || (t.address !== "native" && t.address.toLowerCase() === needle));
  const mcapOf = (t: SwapToken) => stats.find((s) => s.address === t.address);
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
          {shown.map((t) => {
            const s = mcapOf(t);
            return (
              <li key={t.address}>
                <button className="sw-row" onClick={() => onPick(t)}>
                  <Avatar handle={t.symbol} pfp={t.pfp} size={28} />
                  <span className="sw-row-names">
                    <span className="sw-row-symbol">{t.symbol}</span>
                    <span className="sw-row-name">{t.name}</span>
                  </span>
                  {s && <span className="sw-row-mcap">{compactUsd(s.price_hype * 1e9)}</span>}
                </button>
              </li>
            );
          })}
          {shown.length === 0 && <li className="nt-empty">No token matches.</li>}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
