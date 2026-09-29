// Creator profile, opened from the Profile button next to the category badge: a small modal over the center of the
// chart card, with the chart blurred behind it. X link, name, bio (about) and the creator's links, as launched.
// Closes on Escape, the × button or a click outside.
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ExternalLink, X } from "lucide-react";
import { type CreatorProfile, getProfile, type TokenStat } from "../lib/explore";
import { CATEGORIES } from "../lib/launch";
import { EASE_OUT } from "../lib/motion";
import { Avatar } from "./Avatar";

export function ProfileModal({ t, onClose }: { t: TokenStat; onClose: () => void }) {
  const [profile, setProfile] = useState<CreatorProfile | null | undefined>(undefined);
  useEffect(() => {
    getProfile(t.address).then(setProfile, () => setProfile(null));
  }, [t.address]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const cat = CATEGORIES.find((c) => c.id === t.category)?.label ?? t.category;
  return (
    <motion.div
      className="ex-modal-backdrop"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <motion.div
        className="ex-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`@${t.handle} profile`}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 4 }}
        transition={{ duration: 0.22, ease: EASE_OUT }}
      >
        <button className="ex-modal-close" onClick={onClose} aria-label="Close profile">
          <X size={16} />
        </button>
        <header className="ex-modal-head">
          <Avatar handle={t.handle} pfp={t.x_pfp_url} size={52} className="ex-modal-avatar" />
          <div className="ex-head-names">
            <span className="ex-handle">{t.x_name || `@${t.handle}`}</span>
            <a className="ex-modal-x" href={`https://x.com/${t.handle}`} target="_blank" rel="noreferrer">
              @{t.handle} on X <ExternalLink size={11} />
            </a>
          </div>
          <span className="lp-chip">{cat}</span>
        </header>

        <section className="ex-modal-section">
          <h3 className="ex-modal-label">About</h3>
          <p className="ex-modal-about">
            {profile === undefined ? "Loading…" : profile?.about || "This creator hasn't written a bio."}
          </p>
        </section>

        {profile && profile.links.length > 0 && (
          <section className="ex-modal-section">
            <h3 className="ex-modal-label">Links</h3>
            <ul className="ex-modal-links">
              {profile.links.map((l) => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noreferrer noopener">
                    <span>{l.label || hostOf(l.url)}</span>
                    <span className="ex-modal-host">
                      {hostOf(l.url)} <ExternalLink size={11} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="ex-order-note">${t.symbol} is a meme with no promise of value. @{t.handle} owes holders nothing.</p>
      </motion.div>
    </motion.div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
