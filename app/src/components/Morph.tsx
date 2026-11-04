// A top-row button that opens a panel, shared by Account and Neuriio. No animation (user, 2026-11-01), apart from dots lighting up inside it
// on hover (user, 2026-11-02).
// The panel opens anchored to the top-right row; Escape, the × or a click outside closes it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useCardLift } from "./CardStack";
import { ButtonDots } from "./LitDots";

type MorphProps = {
  /** what the closed button shows */
  trigger: ReactNode;
  triggerClassName?: string;
  /** left side of the panel's header row (the × is added on the right) */
  head: ReactNode;
  /** panel content */
  children: ReactNode;
  bodyClassName?: string;
  /** optional layer over the body (e.g. the logged-out Login card); gets `close` */
  overlay?: (close: () => void) => ReactNode;
  label: string;
  /** which side the panel opens from (default: the top-right row) */
  anchor?: "right" | "left";
  /** base look of the closed button (default: a top-row box); e.g. "logo" for the logo tile */
  triggerBase?: string;
  slotClassName?: string;
  /** closed button's radius */
  radius?: number;
};

export function Morph({
  trigger,
  triggerClassName = "",
  head,
  children,
  bodyClassName = "",
  overlay,
  label,
  anchor = "right",
  triggerBase = "panel top-box",
  slotClassName = "top-box-slot",
  radius = 7,
}: MorphProps) {
  const [open, setOpen] = useState(false);
  const slotRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const { front, hoverProps } = useCardLift(label);

  useEffect(() => {
    if (!open) return;
    // a window opened from inside the panel (e.g. notifications) is marked data-morph-keep: while one is open,
    // clicks in it and Escape belong to it, not to this panel
    const keep = () => document.querySelector("[data-morph-keep]");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !keep() && setOpen(false);
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if ((t as Element).closest?.("[data-morph-keep]")) return;
      if (!slotRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <>
      {/* keeps the button's space in the row while its panel is open */}
      <div
        ref={slotRef}
        className={`${slotClassName}${front ? " card-front" : ""}`}
        data-card={label}
        {...hoverProps}
      >
        {!open && (
          <button
            type="button"
            style={{ borderRadius: radius }}
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={label}
            className={`${triggerBase} morph-trigger ${triggerClassName}`}
          >
            <ButtonDots />
            <span className="morph-trigger-content">{trigger}</span>
          </button>
        )}
      </div>

      {open && (
        <div
          ref={panelRef}
          style={{ borderRadius: 7 }}
          className={`morph-panel${anchor === "left" ? " morph-panel-left" : ""}`}
          role="dialog"
          aria-label={label}
        >
          <div className="panel-head">
            {head}
            <button type="button" className="icon-btn" onClick={close} aria-label="Close">
              <X size={18} />
            </button>
          </div>
          <div className={`panel-body ${bodyClassName}`}>{children}</div>
          {overlay?.(close)}
        </div>
      )}
    </>
  );
}
