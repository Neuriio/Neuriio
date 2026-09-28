// Points button: morphs into the points panel. There is no points system yet (no contract or
// backend), so it shows 0.0 and 8 blank boxes to be designed. Logged out, the boxes are blurred
// behind a small "Login to Account" card (text only: logging in happens from the Account button).
import { motion, useReducedMotion } from "motion/react";
import { usePrivy } from "@privy-io/react-auth";
import { Morph } from "./Morph";

const SLOTS = Array.from({ length: 8 }, (_, i) => i);

export function PointsBox() {
  const { ready, authenticated } = usePrivy();
  const reduce = useReducedMotion();
  const locked = !(ready && authenticated);

  return (
    <Morph
      label="Points"
      triggerClassName="points"
      trigger={<span className="top-value">Points</span>}
      head={
        <span className="points-head">
          <span>Points</span>
          <span>0.0</span>
        </span>
      }
      bodyClassName={`points-body${locked ? " panel-body-locked" : ""}`}
      overlay={
        locked
          ? () => (
              <motion.div
                className="lock-overlay"
                initial={reduce ? false : { opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: reduce ? 0 : 0.22, type: "spring", stiffness: 460, damping: 30 }}
              >
                <div className="lock-card">
                  <span className="lock-title">Login to Account</span>
                </div>
              </motion.div>
            )
          : undefined
      }
    >
      <div className="points-grid">
        {SLOTS.map((i) => (
          <div key={i} className="points-slot" />
        ))}
      </div>
    </Morph>
  );
}
