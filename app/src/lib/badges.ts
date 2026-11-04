// The 8 badges, lowest rank first, with the Neuriio each takes (user, 2026-11-02). At 100 Neuriio per $1 a staker earns, that's $10 up to
// $25,000 earned. A rank goes by the Neuriio you hold now.
export const BADGES = [
  { file: "paw-silver.webp", name: "Silver paw", neuriio: 1_000 },
  { file: "paw-black.webp", name: "Platinum paw", neuriio: 5_000 },
  { file: "neuriio-silver.webp", name: "Silver Neuriio", neuriio: 10_000 },
  { file: "neuriio-green.webp", name: "Platinum Neuriio", neuriio: 50_000 },
  { file: "neuriio-gold.webp", name: "Gold Neuriio", neuriio: 100_000 },
  { file: "star-silver.png", name: "Silver star", neuriio: 500_000 },
  { file: "star-black.png", name: "Platinum star", neuriio: 1_000_000 },
  { file: "star-blue.png", name: "Blue star", neuriio: 2_500_000 },
] as const;

export type Rank = {
  /** how many badges this much Neuriio has reached: 0 to 8 */
  earned: number;
  /** the badge after those, or null at the top */
  next: (typeof BADGES)[number] | null;
  /** Neuriio still to go for it */
  toGo: number;
  /** how far from the last badge to the next one: 0 to 1 (1 at the top) */
  progress: number;
};

export function rankOf(neuriio: number): Rank {
  const earned = BADGES.filter((b) => neuriio >= b.neuriio).length;
  const next = BADGES[earned] ?? null;
  if (!next) return { earned, next, toGo: 0, progress: 1 };
  const from = earned ? BADGES[earned - 1].neuriio : 0;
  return { earned, next, toGo: next.neuriio - neuriio, progress: Math.max(0, (neuriio - from) / (next.neuriio - from)) };
}
