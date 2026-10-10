// Creator profile, opened from the Profile button next to the category badge: a small modal over the center of the
// chart card, with the chart blurred behind it. X link, name, bio (about) and the creator's links, as launched.
// Closes on Escape, the × button or a click outside.
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ExternalLink, X } from "lucide-react";
import { type CreatorProfile, displayName, ftfMembers, getProfile, type MemberCard, type TokenStat } from "../lib/explore";
import { CATEGORIES } from "../lib/launch";
import { EASE_OUT } from "../lib/motion";
import { Avatar } from "./Avatar";

/** The creator's bio + links (and an FTF's members), loaded once per token. undefined = loading. */
export function useCreatorProfile(t: TokenStat) {
  const [profile, setProfile] = useState<CreatorProfile | null | undefined>(undefined);
  const [members, setMembers] = useState<MemberCard[] | null>(null);
  useEffect(() => {
    getProfile(t.address).then(setProfile, () => setProfile(null));
    if (t.kind === "ftf" && t.member_x_user_ids) ftfMembers(t.member_x_user_ids).then(setMembers, () => setMembers([]));
  }, [t.address, t.kind, t.member_x_user_ids]);
  return { profile, members };
}

export function ProfileModal({ t, onClose }: { t: TokenStat; onClose: () => void }) {
  const { profile, members } = useCreatorProfile(t);
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
        aria-label={`${displayName(t)} profile`}
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
          <Avatar handle={t.kind === "ftf" ? t.name ?? t.symbol : t.handle} pfp={t.x_pfp_url} size={52} className="ex-modal-avatar" />
          <div className="ex-head-names">
            <span className="ex-handle">{t.kind === "ftf" ? t.name : t.x_name || `@${t.handle}`}</span>
            {t.kind === "ftf" ? (
              <span className="ex-ticker">${t.symbol} · Friends Turned Fam</span>
            ) : (
              <a className="ex-modal-x" href={`https://x.com/${t.handle}`} target="_blank" rel="noreferrer">
                @{t.handle} on X <ExternalLink size={11} />
              </a>
            )}
          </div>
          <span className={`lp-chip${t.kind === "ftf" ? " ex-ftf-chip" : ""}`}>{t.kind === "ftf" ? "FTF" : cat}</span>
        </header>

        <ProfileBody t={t} profile={profile} members={members} />

        <p className="ex-order-note">
          ${t.symbol} is a meme with no promise of value. {t.kind === "ftf" ? "Its members owe" : `@${t.handle} owes`} holders nothing.
        </p>
      </motion.div>
    </motion.div>
  );
}

/** Members (FTF), About and Links sections: the modal's body, also the mobile About tab's. */
export function ProfileBody({
  t,
  profile,
  members,
}: {
  t: TokenStat;
  profile: CreatorProfile | null | undefined;
  members: MemberCard[] | null;
}) {
  return (
    <>
      {t.kind === "ftf" && (
        <section className="ex-modal-section">
          <h3 className="ex-modal-label">Members</h3>
          <ul className="ex-modal-members">
            {(members ?? []).map((m, i) => (
              <li key={m.x_user_id}>
                <a href={`https://x.com/${m.x_handle}`} target="_blank" rel="noreferrer">
                  <Avatar handle={m.x_handle} pfp={m.x_pfp_url} size={28} />
                  <span className="ex-modal-member-names">
                    <span>{m.x_name || `@${m.x_handle}`}</span>
                    <span className="ex-modal-host">@{m.x_handle}{i === 0 ? " · founder" : ""}</span>
                  </span>
                  <ExternalLink size={11} />
                </a>
              </li>
            ))}
            {!members && <li className="ex-modal-host">Loading…</li>}
          </ul>
        </section>
      )}

      <section className="ex-modal-section">
        <h3 className="ex-modal-label">About</h3>
        <p className="ex-modal-about">
          {profile === undefined ? "Loading…" : profile?.about || (t.kind === "ftf" ? "No description yet." : "This creator hasn't written a bio.")}
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
    </>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
