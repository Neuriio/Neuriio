// Menu button (just three bold lines, no box) next to the logo: same click-to-morph spring panel as
// Account/Points, opening from the top-left. Lists the app's sections as plain line items (no boxes).
// Feed (new page, being built), Launch and Explore are links; trading (Perps, Spot, Outcome on one line, the future
// /trade page) is greyed out as "Coming soon".
import { Menu } from "lucide-react";
import { Morph } from "./Morph";

const PAGES = [
  { label: "Feed", href: "/feed", isNew: true },
  { label: "Launch", href: "/launch" },
  { label: "Explore", href: "/explore" },
];

export function MenuBox() {
  return (
    <Morph
      label="Menu"
      anchor="left"
      triggerBase="panel top-box menu-btn"
      slotClassName="menu-slot"
      trigger={<Menu size={24} strokeWidth={2} />}
      head={<span className="points-head">Menu</span>}
    >
      <nav className="menu-list" aria-label="Sections">
        {PAGES.map((p) => (
          <a key={p.href} href={p.href} className="menu-item">
            {p.label}
            {p.isNew && <span className="menu-new">New</span>}
          </a>
        ))}
        {/* /trade: not live yet */}
        <span className="menu-item menu-soon" aria-disabled="true">
          Perps, Spot and Outcome
          <span className="menu-soon-tag">Coming soon</span>
        </span>
      </nav>
    </Morph>
  );
}
