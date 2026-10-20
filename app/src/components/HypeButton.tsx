// Testnet faucet button, under the launch card on /launch (logged in only).
//   First time: "Get testnet funds" opens a pop-up ("Receiving 0.2 HYPE + 50,000 USDC" + Receive); Receive sends, from
//   the faucet wallet to your Neuriio wallet, what this X account hasn't had yet: 0.2 HYPE for gas and 50,000 test USDC
//   to trade, each once per X account ever (ftf function: claimHype). Accounts that already took the HYPE see "Get
//   50,000 test USDC". If the faucet has no HYPE to give, the pop-up files a manual request instead (it lands in the
//   admins' notifications).
//   After both claims: "Request testnet HYPE" is the manual request as before (ftf: hype / hypeStatus): "HYPE requested"
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
const USDC_AMOUNT = "50,000";
const EXPLORER_TX = "https://elysium.kinetiq.xyz/tx/";

type Step = "ask" | "sending" | "sent" | "requested" | "claimed" | "error";
/** What a claim would pay right now. */
type Gives = { hype: boolean; usdc: boolean };

export function HypeButton() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const on = DEMO || (ready && authenticated);
  const [st, setSt] = useState<HypeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [popup, setPopup] = useState<Step | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [asked, setAsked] = useState<Gives>({ hype: true, usdc: true }); // what the open pop-up is paying

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
        setSt((s) => s && { ...s, claimed: s.claimed || !!r.hypeTx || !r.usdcTx, usdcClaimed: s.usdcClaimed || !!r.usdcTx });
      } else if (r.status === "claimed") {
        setPopup("claimed");
        setSt((s) => s && { ...s, claimed: true, usdcClaimed: true });
      } else {
        if (r.usdcTx) setSt((s) => s && { ...s, usdcClaimed: true });
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

  // what a claim still pays this X account (the USDC can be claimed even while a HYPE request is open)
  const gives: Gives = { hype: !st.claimed && !pending, usdc: !st.usdcClaimed };
  const first = gives.hype || gives.usdc;
  const done = !first && (pending || sent);
  const what = gives.hype && gives.usdc ? "testnet funds" : gives.usdc ? `${USDC_AMOUNT} test USDC` : `${AMOUNT} testnet HYPE`;
  const label = error && !popup ? error : first ? `Get ${what}` : pending ? "HYPE requested" : sent ? "HYPE sent" : "Request testnet HYPE";
  const title = first
    ? `Get ${gives.hype && gives.usdc ? `${AMOUNT} HYPE + ${USDC_AMOUNT} USDC` : what} in your Neuriio wallet`
    : pending
      ? "Requested: we'll send testnet HYPE to your wallet soon"
      : sent
        ? "Testnet HYPE was sent to your wallet"
        : "Ask the team for more testnet HYPE";

  return (
    <>
      <button
        className={`panel top-box hype-btn${done ? " hype-btn-done" : ""}${error && !popup ? " hype-btn-error" : ""}`}
        onClick={first ? () => (setAsked(gives), setPopup("ask")) : manual}
        disabled={busy || done}
        title={title}
        aria-label={title}
      >
        {done ? <Check size={14} strokeWidth={3} /> : <Droplet size={14} strokeWidth={2.4} />}
        <span className="top-value hype-btn-text">{label}</span>
      </button>
      <HypePopup step={popup} gives={asked} tx={tx} error={error} onReceive={receive} onClose={() => (setPopup(null), setError(null))} />
    </>
  );
}

function HypePopup({
  step,
  gives,
  tx,
  error,
  onReceive,
  onClose,
}: {
  step: Step | null;
  gives: Gives;
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

  const paying = gives; // fixed when the pop-up opened, while the button behind it updates
  const what = [paying.hype && `${AMOUNT} HYPE`, paying.usdc && `${USDC_AMOUNT} USDC`].filter(Boolean).join(" + ") || `${AMOUNT} HYPE`;
  const body: Record<Step, { title: string; text: string }> = {
    ask: {
      title: `Receiving ${what}`,
      text: `Testnet ${paying.usdc ? "USDC to trade, launch and stake" : "HYPE"}${paying.hype && paying.usdc ? ", and HYPE for gas" : paying.hype ? " for gas" : ""}, in your Neuriio wallet. Once per X account.`,
    },
    sending: { title: `Receiving ${what}`, text: "Sending it to your wallet…" },
    sent: { title: `${what} received`, text: "It's in your Neuriio wallet. Open Account to see it." },
    requested: { title: "Request sent", text: "The faucet is out of HYPE right now, so we've asked the team. Your HYPE will arrive soon." },
    claimed: { title: "Already received", text: "This X account already got its testnet HYPE and USDC." },
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
