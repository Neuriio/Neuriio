// Bottom-center cards: X, docs (GitBook) and Telegram, as white logos (Simple Icons, in
// public/social/). A card without a link yet is shown but not clickable.
type Social = { label: string; icon: string; href?: string };

const SOCIALS: Social[] = [
  { label: "Neuriio on X", icon: "/social/x.svg", href: "https://x.com/Neuriio" },
  { label: "Docs", icon: "/social/gitbook.svg", href: "https://docs.neuriio.xyz" },
  { label: "Telegram", icon: "/social/telegram.svg" }, // group not set up yet
];

export function SocialLinks() {
  return (
    <footer className="bottom">
      {SOCIALS.map((s) =>
        s.href ? (
          <a key={s.label} className="panel foot-slot social" href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label} title={s.label}>
            <img src={s.icon} alt="" />
          </a>
        ) : (
          <span key={s.label} className="panel foot-slot social social-soon" aria-label={`${s.label} (coming soon)`} title={`${s.label}: coming soon`}>
            <img src={s.icon} alt="" />
          </span>
        ),
      )}
    </footer>
  );
}
