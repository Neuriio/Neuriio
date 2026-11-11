// /swap, Bridge mode (user, 2026-11-09): HYPE between Elysium and HyperEVM in seconds through Relay (lib/relay.ts), in the swap
// card's own look. Elysium -> HyperEVM skips the canonical ~5.5-day withdrawal for Relay's fee; small amounts cost more because
// part of the fee is fixed. Sends from the wallet in the header chip (an added wallet, or the Neuriio wallet: lib/tradeWallet.ts);
// arrives at the same address unless "Send to" names another.
import { useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { ArrowDownUp } from "lucide-react";
import { formatEther, isAddress, parseEther, type Address } from "viem";
import { pub } from "../lib/launch";
import { amount as fmtAmount } from "../lib/format";
import { bridgeQuote, bridgeSend, ELYSIUM_ID, HYPEREVM_ID, hyperPub, type BridgeQuote } from "../lib/relay";
import { friendlyTradeError } from "../lib/trade";
import { useTradeWallet } from "../lib/tradeWallet";
import { AddWalletModal } from "./PortfolioPanel";
import { TradeWalletChip } from "./TradeWalletChip";

const NAME: Record<number, string> = { [ELYSIUM_ID]: "Elysium", [HYPEREVM_ID]: "HyperEVM" };
const GAS_RESERVE = parseEther("0.002"); // left on the sending chain for gas
const COST_WARN = 8; // %

type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "done"; text: string } | { kind: "error"; text: string };

function useHypeBalance(wallet: Address | undefined, chainId: number, nonce: number) {
  const [bal, setBal] = useState<bigint | null>(null);
  useEffect(() => {
    setBal(null);
    if (!wallet) return;
    let alive = true;
    (chainId === HYPEREVM_ID ? hyperPub : pub).getBalance({ address: wallet }).then((b) => alive && setBal(b), () => {});
    return () => {
      alive = false;
    };
  }, [wallet, chainId, nonce]);
  return bal;
}

export function BridgeCard() {
  // no login needed (user, 2026-11-11): an added wallet bridges too; the Neuriio wallet when logged in
  const { ready } = usePrivy();
  const { list, active, choose: chooseWallet } = useTradeWallet();
  const me = active?.address;
  const [adding, setAdding] = useState(false);

  const [from, setFrom] = useState<number>(ELYSIUM_ID);
  const to = from === ELYSIUM_ID ? HYPEREVM_ID : ELYSIUM_ID;
  const [amountIn, setAmountIn] = useState("");
  const [recipient, setRecipient] = useState("");
  const [q, setQ] = useState<BridgeQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [nonce, setNonce] = useState(0);
  const fromBal = useHypeBalance(me, from, nonce);
  const toBal = useHypeBalance(me, to, nonce);

  const wei = useMemo(() => {
    try {
      return amountIn ? parseEther(amountIn) : 0n;
    } catch {
      return 0n;
    }
  }, [amountIn]);
  const sendTo = (recipient.trim() || me || "") as Address;
  const badRecipient = recipient.trim() !== "" && !isAddress(recipient.trim());

  useEffect(() => {
    setQ(null);
    setQuoteError(null);
    if (wei === 0n || badRecipient) return;
    let alive = true;
    setQuoting(true);
    const id = setTimeout(() => {
      const user = (me ?? "0x000000000000000000000000000000000000dEaD") as Address; // a quote doesn't need a login
      bridgeQuote({ user, recipient: (sendTo || user) as Address, from, to, amountWei: wei })
        .then((r) => alive && setQ(r), (e) => alive && setQuoteError((e as Error).message))
        .finally(() => alive && setQuoting(false));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [wei, from, to, me, sendTo, badRecipient, nonce]);

  const edit = (v: string) => {
    setAmountIn(v);
    setStatus({ kind: "idle" });
  };
  const flip = () => {
    setFrom(to);
    edit("");
  };
  const useMax = () => fromBal !== null && edit(formatEther(fromBal > GAS_RESERVE ? fromBal - GAS_RESERVE : 0n));

  async function submit() {
    if (!active || !q) return;
    setStatus({ kind: "busy", label: "Sending…" });
    try {
      await bridgeSend(active, q, (label) => setStatus({ kind: "busy", label }));
      setStatus({ kind: "done", text: `Bridged. ${fmtAmount(q.amountOut)} HYPE arrived on ${NAME[to]}.` });
      setAmountIn("");
      setNonce((n) => n + 1);
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      setStatus({ kind: "error", text: /Relay|relay\.link/.test(m) ? m : friendlyTradeError(m) });
    }
  }

  const tooMuch = fromBal !== null && wei + GAS_RESERVE > fromBal;
  const button = !ready
    ? { label: "Loading…", disabled: true, onClick: undefined }
    : !active
      ? { label: "Connect a wallet", disabled: false, onClick: () => setAdding(true) }
      : status.kind === "busy"
        ? { label: status.label, disabled: true, onClick: undefined }
        : wei === 0n
          ? { label: "Enter an amount", disabled: true, onClick: undefined }
          : badRecipient
            ? { label: "Check the address", disabled: true, onClick: undefined }
            : tooMuch
              ? { label: "Not enough HYPE (keep some for gas)", disabled: true, onClick: undefined }
              : !q
                ? { label: quoting ? "Getting a quote…" : "No route", disabled: true, onClick: undefined }
                : { label: `Bridge to ${NAME[to]}`, disabled: false, onClick: submit };

  return (
    <section className="panel sw-card">
      <header className="sw-head">
        <span className="sw-title">Bridge</span>
        <TradeWalletChip list={list} active={active} onChoose={chooseWallet} />
      </header>
      <AddWalletModal open={adding} onClose={() => setAdding(false)} />

      <div className="sw-box">
        <div className="sw-box-top">
          <span>From {NAME[from]}</span>
          {fromBal !== null && (
            <button className="sw-max" onClick={useMax} title="Your whole balance, less a little for gas">
              Balance {fmtAmount(Number(formatEther(fromBal)))}
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
            aria-label={`Amount of HYPE to send from ${NAME[from]}`}
          />
          <span className="sw-token br-token">
            <img src="/tokens/hype.svg" alt="" className="br-logo" />
            HYPE
          </span>
        </div>
      </div>

      <button className="sw-flip" aria-label="Switch direction" onClick={flip}>
        <ArrowDownUp size={15} />
      </button>

      <div className="sw-box">
        <div className="sw-box-top">
          <span>To {NAME[to]}</span>
          {toBal !== null && <span>Balance {fmtAmount(Number(formatEther(toBal)))}</span>}
        </div>
        <div className="sw-box-row">
          <span className={`sw-output${q ? " is-set" : ""}`}>{q ? fmtAmount(q.amountOut) : quoting ? "…" : "—"}</span>
          <span className="sw-token br-token">
            <img src="/tokens/hype.svg" alt="" className="br-logo" />
            HYPE
          </span>
        </div>
      </div>

      <label className="br-to">
        <span>Send to</span>
        <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder={active ? `Same address (${active.kind === "neuriio" ? "your Neuriio wallet" : active.name})` : "0x… (optional)"} spellCheck={false} />
      </label>

      {q && (
        <dl className="sw-details">
          <div>
            <dt>Cost</dt>
            <dd className={q.costPct !== null && q.costPct > COST_WARN ? "price-down" : undefined}>
              {q.costPct !== null ? `${q.costPct.toFixed(2)}%` : "—"} {q.costUsd > 0 && `(~$${q.costUsd.toFixed(2)})`}
            </dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{q.seconds ? `~${q.seconds} s` : "seconds"}</dd>
          </div>
        </dl>
      )}
      {q && q.costPct !== null && q.costPct > COST_WARN && <p className="sw-warn">Small amounts cost more: part of Relay's fee is fixed.</p>}
      {quoteError && wei > 0n && !quoting && <p className="sw-warn">{quoteError}</p>}
      {status.kind === "done" && <p className="sw-msg price-up">{status.text}</p>}
      {status.kind === "error" && <p className="sw-msg price-down">{status.text}</p>}

      <button className="lock-login sw-go" disabled={button.disabled} onClick={button.onClick}>
        {button.label}
      </button>
      <a className="br-powered" href="https://relay.link" target="_blank" rel="noreferrer">
        Powered by <img src="/brand/relay-white.svg" alt="Relay" />
      </a>
    </section>
  );
}

