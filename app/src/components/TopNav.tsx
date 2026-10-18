// The app's sections as links in the header (user, 2026-10-18, like Blockworks), on every page but the landing and at
// every size: beside the logo on wide screens, in their own row under it on narrower ones (they scroll sideways if
// they don't fit). Feed (new), Launch, Trending and Explore; trading (Perps, Spot, Outcome: the future /trade page)
// shows as "Trade · Soon". The current page is highlighted.
const PAGES = [
  { label: "Feed", href: "/feed", isNew: true },
  { label: "Launch", href: "/launch" },
  { label: "Trending", href: "/trending" },
  { label: "Explore", href: "/explore" },
];

export function TopNav({ current }: { current: string }) {
  return (
    <nav className="top-nav" aria-label="Sections">
      {PAGES.map((p) => (
        <a key={p.href} href={p.href} className={`top-nav-link${current === p.href ? " is-on" : ""}`} aria-current={current === p.href ? "page" : undefined}>
          {p.label}
          {p.isNew && <span className="menu-new">New</span>}
        </a>
      ))}
      <span className="top-nav-link top-nav-soon" aria-disabled="true" title="Perps, Spot and Outcome: coming soon">
        Trade <span className="menu-soon-tag">Soon</span>
      </span>
    </nav>
  );
}
