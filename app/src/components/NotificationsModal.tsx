// Notifications window, opened from the bell next to your name in the Account panel: FTF invites to you (Accept /
// Decline: an off-chain "yes", no transaction) and people asking to join FTFs you founded (Approve / Decline). Admins also
// see testnet HYPE requests (who + the wallet to send to, with Copy; Sent / Dismiss).
// Rendered over the page with the background blurred; Escape, × or a click outside closes it.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { usePrivy } from "@privy-io/react-auth";
import { Bell, Check, Copy, X } from "lucide-react";
import { ftfCall, type Notice, useNotifications } from "../lib/ftf";
import { handleOf, tickerOf } from "../lib/explore";
import { EASE_OUT } from "../lib/motion";
import { Avatar } from "./Avatar";

export function NotificationsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useNotifications();

  useEffect(() => {
    if (!open) return;
    refresh();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="nt-backdrop"
          data-morph-keep
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            className="nt-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
          >
            <header className="nt-head">
              <span className="nt-title">
                <Bell size={15} /> Notifications
              </span>
              <button className="ex-modal-close" onClick={onClose} aria-label="Close notifications">
                <X size={16} />
              </button>
            </header>

            <NotificationsList />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** The notifications themselves with Accept / Approve / Decline: the window's body, also the mobile Feed's
 *  Notifications tab. */
export function NotificationsList() {
  const { getAccessToken } = usePrivy();
  const { items, refresh } = useNotifications();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [copied, setCopied] = useState<number | null>(null);
  const keyOf = (n: Notice) => (n.kind === "hype" ? `hype:${n.id}` : `${n.kind}:${n.draftId}:${n.from.x_user_id}`);

  const act = async (n: Notice, yes: boolean) => {
    const key = keyOf(n);
    setBusy(key);
    setError(null);
    try {
      if (n.kind === "hype") await ftfCall(getAccessToken, "hypeDone", { id: n.id, sent: yes });
      else if (n.kind === "invite") await ftfCall(getAccessToken, yes ? "accept" : "decline", { draftId: n.draftId });
      else await ftfCall(getAccessToken, yes ? "approve" : "remove", { draftId: n.draftId, xUserId: n.from.x_user_id });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {items.length === 0 ? (
        <p className="nt-empty">Nothing new. FTF invites and requests show up here.</p>
      ) : (
        <ul className="nt-list">
          {items.map((n) => {
            const key = keyOf(n);
            const who = n.from.x_handle ? handleOf(n.from.x_handle) : "Someone";
            if (n.kind === "hype") {
              const copy = () =>
                navigator.clipboard.writeText(n.wallet).then(() => {
                  setCopied(n.id);
                  setTimeout(() => setCopied((c) => (c === n.id ? null : c)), 1500);
                });
              return (
                <li key={key} className="nt-item">
                  <Avatar handle={n.from.x_handle ?? "?"} pfp={n.from.x_pfp_url ?? null} size={34} />
                  <div className="nt-text">
                    <span>
                      <b>{who}</b> asked for testnet HYPE
                    </span>
                    <button className="nt-wallet" onClick={copy} title="Copy wallet">
                      {n.wallet.slice(0, 6)}…{n.wallet.slice(-4)}
                      {copied === n.id ? <Check size={11} strokeWidth={3} /> : <Copy size={11} />}
                    </button>
                  </div>
                  <div className="nt-actions">
                    <button className="nt-yes" disabled={busy === key} onClick={() => act(n, true)}>
                      <Check size={13} strokeWidth={3} /> Sent
                    </button>
                    <button className="nt-no" disabled={busy === key} onClick={() => act(n, false)}>
                      Dismiss
                    </button>
                  </div>
                </li>
              );
            }
            return (
              <li key={key} className="nt-item">
                <Avatar handle={n.from.x_handle ?? "?"} pfp={n.from.x_pfp_url ?? null} size={34} />
                <div className="nt-text">
                  <span>
                    <b>{who}</b> {n.kind === "invite" ? "invited you to" : "asked to join"} <b>{n.name}</b>{" "}
                    <span className="nt-ticker">{tickerOf(n.ticker)}</span>
                  </span>
                  <span className="nt-sub">
                    {n.kind === "invite" ? "An FTF: 4 people, one token. Accepting isn't a transaction." : "You founded this FTF."}
                  </span>
                </div>
                <div className="nt-actions">
                  <button className="nt-yes" disabled={busy === key} onClick={() => act(n, true)}>
                    <Check size={13} strokeWidth={3} /> {n.kind === "invite" ? "Accept" : "Approve"}
                  </button>
                  <button className="nt-no" disabled={busy === key} onClick={() => act(n, false)}>
                    Decline
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="nt-error">{error}</p>}
    </>
  );
}
