// Send window (Feed): pick one of your Elysium tokens, enter an amount, send it to the poster's Neuriio wallet.
// Over the blurred page like Notifications; Escape, × or a click outside closes it (not while sending).
// `to` null = a sample post with no wallet behind it: the window shows but can't send. `?demo` simulates a send.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatUnits, parseEther, parseUnits, type Address } from "viem";
import { Check, ExternalLink, LoaderCircle, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { EASE_OUT } from "../lib/motion";
import { amount as fmt } from "../lib/format";
import { DEMO } from "../lib/explore";
import { elysiumProvider } from "../lib/tx";
import { elysiumTestnet } from "../chain";
import { GAS_RESERVE, sendableTokens, sendToken, type SendToken } from "../lib/send";

export type SendTarget = { handle: string; name: string; pfp: string | null; wallet: Address | null };

type Phase = { kind: "form" } | { kind: "sending" } | { kind: "sent"; hash: string } | { kind: "error"; message: string };

const DEMO_TOKENS: SendToken[] = [
  { key: "native", symbol: "HYPE", label: "HYPE", address: null, decimals: 18, balance: parseEther("2.85"), pfp: null, launched: false },
  { key: "usdc", symbol: "USDC", label: "USDC", address: "0x0000000000000000000000000000000000000001", decimals: 6, balance: 552_020_000n, pfp: null, launched: false },
  { key: "kid", symbol: "KNTQKID", label: "@kntqkid", address: "0x0000000000000000000000000000000000000002", decimals: 18, balance: parseEther("1250000"), pfp: null, launched: true },
  { key: "den", symbol: "DEN", label: "Degen Den", address: "0x0000000000000000000000000000000000000003", decimals: 18, balance: parseEther("480000"), pfp: null, launched: true },
];

export function SendModal({ target, onClose }: { target: SendTarget | null; onClose: () => void }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy");
  const from = wallet?.address as Address | undefined;
  const [tokens, setTokens] = useState<SendToken[] | null>(null);
  const [picked, setPicked] = useState<SendToken | null>(null);
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  // fresh state + balances each time it opens
  useEffect(() => {
    if (!target) return;
    setPicked(null);
    setValue("");
    setPhase({ kind: "form" });
    setTokens(null);
    if (DEMO) return setTokens(DEMO_TOKENS);
    if (!from) return;
    sendableTokens(from).then(setTokens, () => setTokens([]));
  }, [target, from]);

  const busy = phase.kind === "sending";
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [target, busy, onClose]);

  const max = picked ? (picked.address ? picked.balance : picked.balance > GAS_RESERVE ? picked.balance - GAS_RESERVE : 0n) : 0n;
  let units: bigint | null = null;
  try {
    units = picked && value.trim() ? parseUnits(value.trim(), picked.decimals) : null;
  } catch {
    units = null;
  }
  const tooMuch = units !== null && units > max;
  const canSend = !!picked && units !== null && units > 0n && !tooMuch && (DEMO || !!target?.wallet);

  async function send() {
    if (!picked || !units || !target) return;
    setPhase({ kind: "sending" });
    try {
      if (DEMO) {
        await new Promise((r) => setTimeout(r, 1400));
        return setPhase({ kind: "sent", hash: "" });
      }
      const hash = await sendToken(await elysiumProvider(wallet!), from!, target.wallet!, picked, units);
      setPhase({ kind: "sent", hash });
    } catch (e) {
      const m = (e as Error).message ?? "";
      setPhase({ kind: "error", message: /reject|denied|cancel/i.test(m) ? "Cancelled" : m.split("\n")[0].slice(0, 160) });
    }
  }

  const loggedIn = DEMO || (ready && authenticated);
  return createPortal(
    <AnimatePresence>
      {target && (
        <motion.div
          className="nt-backdrop"
          data-morph-keep
          onClick={() => !busy && onClose()}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            className="nt-modal send-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Send to @${target.handle}`}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
          >
            <header className="nt-head">
              <span className="nt-title send-to">
                Send to <Avatar handle={target.handle} pfp={target.pfp} size={22} /> <b>@{target.handle}</b>
              </span>
              <button className="ex-modal-close" onClick={onClose} disabled={busy} aria-label="Close">
                <X size={16} />
              </button>
            </header>

            {!loggedIn ? (
              <div className="send-empty">
                <p>Log in to send tokens.</p>
                <button className="lock-login" onClick={login} disabled={!ready}>
                  Login
                </button>
              </div>
            ) : phase.kind === "sent" ? (
              <div className="send-done">
                <span className="send-done-icon">
                  <Check size={20} strokeWidth={3} />
                </span>
                <p>
                  Sent {value} {picked?.symbol} to @{target.handle}
                </p>
                {phase.hash && (
                  <a className="link-btn" target="_blank" rel="noreferrer" href={`${elysiumTestnet.blockExplorers.default.url}/tx/${phase.hash}`}>
                    View transaction <ExternalLink size={11} />
                  </a>
                )}
                <button className="lock-login" onClick={onClose}>
                  Done
                </button>
              </div>
            ) : (
              <>
                <span className="feed-side-title">Your tokens on Elysium</span>
                <ul className="send-tokens">
                  {tokens?.map((t) => (
                    <li key={t.key}>
                      <button
                        className={`send-token${picked?.key === t.key ? " is-on" : ""}`}
                        onClick={() => {
                          setPicked(t);
                          setValue("");
                        }}
                        disabled={busy}
                      >
                        <Avatar handle={t.launched ? t.label.replace("@", "") : t.symbol} pfp={t.pfp} size={26} />
                        <span className="send-token-names">
                          <span className="send-token-label">{t.label}</span>
                          {t.launched && <span className="feed-ticker">${t.symbol}</span>}
                        </span>
                        <span className="send-token-bal">{fmt(Number(formatUnits(t.balance, t.decimals)))}</span>
                      </button>
                    </li>
                  ))}
                  {tokens && tokens.length === 0 && <li className="nt-empty">No tokens on Elysium yet.</li>}
                  {!tokens && <li className="nt-empty">Loading your tokens…</li>}
                </ul>

                {picked && (
                  <label className="send-amount">
                    <span className="feed-side-title">Amount</span>
                    <span className={`send-input${tooMuch ? " is-bad" : ""}`}>
                      <input
                        value={value}
                        onChange={(e) => setValue(e.target.value.replace(",", "."))}
                        placeholder="0.0"
                        inputMode="decimal"
                        autoFocus
                        disabled={busy}
                      />
                      <span className="send-sym">{picked.symbol}</span>
                      <button className="link-btn" type="button" onClick={() => setValue(formatUnits(max, picked.decimals))} disabled={busy}>
                        Max
                      </button>
                    </span>
                    {tooMuch && <span className="lp-warn">More than you have{picked.address ? "" : " (a little HYPE stays for gas)"}</span>}
                  </label>
                )}

                {!DEMO && !target.wallet && <p className="send-note">Sample post: there's no wallet behind it, so it can't receive yet.</p>}
                {phase.kind === "error" && <p className="nt-error">{phase.message}</p>}

                <button className="lock-login send-go" disabled={!canSend || busy} onClick={send}>
                  {busy ? <LoaderCircle size={13} className="spin" /> : null}
                  {busy ? "Sending…" : picked && units ? `Send ${value} ${picked.symbol}` : "Send"}
                </button>
                <p className="send-note">Goes straight to their Neuriio wallet. You pay a little HYPE for gas.</p>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
