// "Request testnet HYPE" button, under the launch card on /launch (logged in only). One click asks for testnet HYPE to
// your Neuriio wallet: the request lands in the admins' notifications (ftf function: hype / hypeStatus), they send it by
// hand and mark it sent. Shows "Requested" while it's open and "HYPE sent" for 24 h after.
import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { Check, Droplet } from "lucide-react";
import { DEMO, ftfCall, type HypeStatus } from "../lib/ftf";

const AGAIN_MS = 24 * 60 * 60 * 1000;

export function HypeButton() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const on = DEMO || (ready && authenticated);
  const [st, setSt] = useState<HypeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    ftfCall<HypeStatus>(getAccessToken, "hypeStatus").then(setSt, () => {});
  }, [getAccessToken]);

  useEffect(() => {
    if (!on) return setSt(null);
    load();
  }, [on, load]);

  // while it's open, check every minute so "Requested" turns into "HYPE sent"
  useEffect(() => {
    if (st?.status !== "pending") return;
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [st?.status, load]);

  if (!on) return null;

  const pending = st?.status === "pending";
  const sent = st?.status === "sent" && !!st.at && Date.now() - Date.parse(st.at) < AGAIN_MS;

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      setSt(await ftfCall<HypeStatus>(getAccessToken, "hype"));
    } catch (e) {
      setError((e as Error).message);
      setTimeout(() => setError(null), 4000);
    } finally {
      setBusy(false);
    }
  };

  const label = error ?? (pending ? "HYPE requested" : sent ? "HYPE sent" : "Request testnet HYPE");
  const title = error ?? (pending ? "Requested: we'll send testnet HYPE to your wallet soon" : sent ? "Testnet HYPE was sent to your wallet" : "Ask for testnet HYPE to your Neuriio wallet");

  return (
    <button
      className={`panel top-box hype-btn${pending || sent ? " hype-btn-done" : ""}${error ? " hype-btn-error" : ""}`}
      onClick={request}
      disabled={busy || pending || sent}
      title={title}
      aria-label={title}
    >
      {pending || sent ? <Check size={14} strokeWidth={3} /> : <Droplet size={14} strokeWidth={2.4} />}
      <span className="top-value hype-btn-text">{label}</span>
    </button>
  );
}
