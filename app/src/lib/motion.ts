// Shared animation curves/springs (from the reference button's architecture).
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Button <-> panel morph. */
export const SPRING_MORPH = { type: "spring", stiffness: 320, damping: 24, mass: 0.9 } as const;

/** Card deck hover: the hovered card springs up, the other springs down. */
export const SPRING_LIFT = { type: "spring", stiffness: 520, damping: 22, mass: 0.6 } as const;
