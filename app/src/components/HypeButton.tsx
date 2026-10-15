// Testnet HYPE button, under the launch card on /launch (logged in only).
//   First time: "Get 0.2 testnet HYPE" opens a pop-up ("Receiving 0.2 HYPE" + Receive); Receive sends 0.2 HYPE from the
//   faucet wallet to your Neuriio wallet, once per X account ever (ftf function: claimHype). If the faucet can't pay
//   right now, the pop-up files a manual request instead (it lands in the admins' notifications).
//   After your claim: "Request testnet HYPE" is the manual request as before (ftf: hype / hypeStatus): "HYPE requested"
//   while it's open and "HYPE sent" for 24 h after an admin sends it.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { usePrivy } from "@privy-io/react-auth";
import { Check, Droplet, ExternalLink, X } from "lucide-react";
import { DEMO, ftfCall, type HypeClaim, type HypeStatus } from "../lib/ftf";
import { EASE_OUT } from "../lib/motion";

const AGAIN_MS = 24 * 60 * 60 * 1000;
const AMOUNT = "0.2";
const EXPLORER_TX = "https://elysium.kinetiq.xyz/tx/";

type Step = "ask" | "sending" | "sent" | "requested" | "claimed" | "error";

export function HypeButton() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const on = DEMO || (ready && authenticated);
  const [st, setSt] = useState<HypeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [popup, setPopup] = useState<Step | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const load = useCallback(() => {
    ftfCall<HypeStatus>(getAccessToken, "hypeStatus").then(setSt, () => {});
  }, [getAccessToken]);

  useEffect(() => {
    if (!on) return setSt(null);
    load();
  }, [on, load]);

  // while a manual request is open, check every minute so "Requested" turns into "HYPE sent"
  useEffect(() => {
    if (st?.status !== "pending") return;
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [st?.status, load]);

  if (!on || !st) return null;

  const pending = st.status === "pending";
  const sent = st.status === "sent" && !!st.at && Date.now() - Date.parse(st.at) < AGAIN_MS;

  /** The manual request (the admins send it by hand). */
  const request = async () => {
    setSt(await ftfCall<HypeStatus>(getAccessToken, "hype"));
  };

  const receive = async () => {
    setPopup("sending");
    try {
      const r = await ftfCall<HypeClaim>(getAccessToken, "claimHype");
      if (r.status === "sent") {
        setTx(r.tx);
        setPopup("sent");
        setSt((s) => s && { ...s, claimed: true });
      } else if (r.status === "claimed") {
        setPopup("claimed");
        setSt((s) => s && { ...s, claimed: true });
      } else {
        await request(); // the faucet can't pay right now: ask the team instead
        setPopup("requested");
      }
    } catch (e) {
      setError((e as Error).message);
      setPopup("error");
    }
  };

  const manual = async () => {
    setBusy(true);
    setError(null);
    try {
      await request();
    } catch (e) {
      setError((e as Error).message);
      setTimeout(() => setError(null), 4000);
    } finally {
      setBusy(false);
    }
  };

  const first = !st.claimed && !pending;
  const done = !first && (pending || sent);
  const label = error && !popup ? error : first ? `Get ${AMOUNT} testnet HYPE` : pending ? "HYPE requested" : sent ? "HYPE sent" : "Request testnet HYPE";
  const title = first
    ? `Get ${AMOUNT} testnet HYPE in your Neuriio wallet`
    : pending
      ? "Requested: we'll send testnet HYPE to your wallet soon"
      : sent
        ? "Testnet HYPE was sent to your wallet"
        : "Ask the team for more testnet HYPE";

  return (
    <>
      <button
        className={`panel top-box hype-btn${done ? " hype-btn-done" : ""}${error && !popup ? " hype-btn-error" : ""}`}
        onClick={first ? () => setPopup("ask") : manual}
        disabled={busy || done}
        title={title}
        aria-label={title}
      >
        {done ? <Check size={14} strokeWidth={3} /> : <Droplet size={14} strokeWidth={2.4} />}
        <span className="top-value hype-btn-text">{label}</span>
      </button>
      <HypePopup step={popup} tx={tx} error={error} onReceive={receive} onClose={() => (setPopup(null), setError(null))} />
    </>
  );
}

function HypePopup({
  step,
  tx,
  error,
  onReceive,
  onClose,
}: {
  step: Step | null;
  tx: string | null;
  error: string | null;
  onReceive: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!step || step === "sending") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [step, onClose]);

  const body: Record<Step, { title: string; text: string }> = {
    ask: { title: `Receiving ${AMOUNT} HYPE`, text: "Testnet HYPE for your Neuriio wallet, to launch and trade. One per X account." },
    sending: { title: `Receiving ${AMOUNT} HYPE`, text: "Sending it to your wallet…" },
    sent: { title: `${AMOUNT} HYPE received`, text: "It's in your Neuriio wallet. Open Account to see it." },
    requested: { title: "Request sent", text: "The faucet is out right now, so we've asked the team. Your HYPE will arrive soon." },
    claimed: { title: "Already received", text: `This X account already got its ${AMOUNT} HYPE.` },
    error: { title: "Something went wrong", text: error ?? "Try again in a moment." },
  };

  return createPortal(
    <AnimatePresence>
      {step && (
        <motion.div
          className="nt-backdrop"
          onClick={step === "sending" ? undefined : onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            className="nt-modal hype-modal"
            role="dialog"
            aria-modal="true"
            aria-label={body[step].title}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
          >
            <header className="nt-head">
              <span className="nt-title">
                {step === "sent" ? <Check size={15} strokeWidth={3} /> : <Droplet size={15} />} {body[step].title}
              </span>
              {step !== "sending" && (
                <button className="ex-modal-close" onClick={onClose} aria-label="Close">
                  <X size={16} />
                </button>
              )}
            </header>
            <p className="hype-modal-text">{body[step].text}</p>
            {step === "sent" && tx && (
              <a className="hype-modal-tx" href={EXPLORER_TX + tx} target="_blank" rel="noreferrer">
                View transaction <ExternalLink size={12} />
              </a>
            )}
            <div className="hype-modal-actions">
              {step === "ask" || step === "sending" ? (
                <button className="nt-yes" onClick={onReceive} disabled={step === "sending"}>
                  {step === "sending" ? "Receiving…" : "Receive"}
                </button>
              ) : (
                <button className="nt-no" onClick={onClose}>
                  Close
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
