// Menu button (just three bold lines, no box) next to the logo: same click-to-morph spring panel as
// Account/Points, opening from the top-left. Lists the app's sections as plain line items (no boxes).
// Explore and Launch are live pages; the others aren't built yet.
import { Menu } from "lucide-react";
import { Morph } from "./Morph";

const PAGES = [
  { label: "Explore", href: "/explore" },
  { label: "Launch", href: "/launch" },
];
const ITEMS = ["Dashboard", "Spot", "Perps", "Outcome"];

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
          </a>
        ))}
        {ITEMS.map((item) => (
          <button key={item} type="button" className="menu-item">
            {item}
          </button>
        ))}
      </nav>
    </Morph>
  );
}
