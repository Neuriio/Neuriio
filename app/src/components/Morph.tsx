// A top-row button that MORPHS into a panel (spring), shared by Account and Points.
// The panel opens anchored to the top-right row; Escape, the × or a click outside morphs it back.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { EASE_OUT, SPRING_LIFT, SPRING_MORPH } from "../lib/motion";
import { useCardLift } from "./CardStack";

type MorphProps = {
  /** what the closed button shows */
  trigger: ReactNode;
  triggerClassName?: string;
  /** left side of the panel's header row (the × is added on the right) */
  head: ReactNode;
  /** panel content, revealed top-to-bottom after the morph */
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
  /** closed button's radius, kept through the morph */
  radius?: number;
  /** hover lift when the button is not part of the card deck */
  hoverLift?: number;
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
  hoverLift,
}: MorphProps) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const layoutId = useId();
  const slotRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const morph = reduce ? { duration: 0.15 } : SPRING_MORPH;
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
      {/* keeps the button's space in the row while it is morphed open */}
      <div
        ref={slotRef}
        className={`${slotClassName}${front ? " card-front" : ""}`}
        data-card={label}
        {...hoverProps}
      >
        <AnimatePresence initial={false}>
          {!open && (
            <motion.button
              key="trigger"
              type="button"
              layoutId={layoutId}
              transition={{ default: morph, layout: morph, y: SPRING_LIFT }}
              whileHover={hoverLift && !reduce ? { y: -hoverLift } : undefined}
              style={{ borderRadius: radius }}
              onClick={() => setOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-label={label}
              whileTap={reduce ? undefined : { scale: 0.97 }}
              className={`${triggerBase} morph-trigger ${triggerClassName}`}
            >
              <motion.span layout className="morph-trigger-content">
                {trigger}
              </motion.span>
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            ref={panelRef}
            layoutId={layoutId}
            transition={morph}
            style={{ borderRadius: 7 }}
            className={`morph-panel${anchor === "left" ? " morph-panel-left" : ""}`}
            role="dialog"
            aria-label={label}
          >
            <motion.div
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: reduce ? 0 : 0.12, duration: 0.2 }}
            >
              <div className="panel-head">
                {head}
                <button type="button" className="icon-btn" onClick={close} aria-label="Close">
                  <X size={18} />
                </button>
              </div>
              <motion.div
                className={`panel-body ${bodyClassName}`}
                initial={reduce ? false : { clipPath: "inset(0 0 100% 0)" }}
                animate={{ clipPath: "inset(0 0 0% 0)" }}
                transition={{ delay: reduce ? 0 : 0.1, duration: 0.4, ease: EASE_OUT }}
              >
                {children}
              </motion.div>
              {overlay?.(close)}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
