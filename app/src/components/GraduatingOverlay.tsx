// Full-page moment while a buy graduates a token (sells the curve's last tokens -> the same transaction opens the
// pool and burns the LP): light blur over the page, a glowing orb, "Graduating". On success it turns into
// "Graduated" for a moment, then fades out. stage null = hidden. Shown by OrderCard for the buyer, and by Explore's
// token view for everyone else watching (the watcher's live "graduated" event).
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import { EASE_OUT } from "../lib/motion";

export type GradStage = "graduating" | "graduated" | null;

/** Tokens this browser is graduating itself (OrderCard shows its own overlay), so the live event doesn't repeat it. */
export const ownGraduations = new Set<string>();

export function GraduatingOverlay({ stage, symbol }: { stage: GradStage; symbol: string }) {
  return createPortal(
    <AnimatePresence>
      {stage && (
        <motion.div
          className="grad-backdrop"
          data-morph-keep
          role="status"
          aria-live="polite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.5 } }}
          transition={{ duration: 0.3 }}
        >
          <motion.div
            className="grad-center"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: EASE_OUT }}
          >
            <div className={`grad-orb${stage === "graduated" ? " is-done" : ""}`} aria-hidden>
              <span className="grad-ring" />
              <span className="grad-ring grad-ring-2" />
              <span className="grad-core" />
              {stage === "graduated" && (
                <motion.span className="grad-check" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.35, ease: EASE_OUT }}>
                  <Check size={34} strokeWidth={3} />
                </motion.span>
              )}
            </div>
            <AnimatePresence mode="wait">
              <motion.div
                key={stage}
                className="grad-text"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25, ease: EASE_OUT }}
              >
                <span className="grad-title">
                  {stage === "graduating" ? (
                    <>
                      Graduating
                      <span className="grad-dots">
                        <i>.</i>
                        <i>.</i>
                        <i>.</i>
                      </span>
                    </>
                  ) : (
                    "Graduated"
                  )}
                </span>
                <span className="grad-sub">
                  {stage === "graduating" ? `$${symbol} is moving from the curve to its pool` : `$${symbol} now trades in its pool · LP burned`}
                </span>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
