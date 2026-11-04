// Explore's Launch check: who bought a token right after launch and which of them are tied together. Worked out from public chain data by
// keeper/launch-check.mjs; this only reads it. `?demo`: sample numbers.
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

export type LinkReason = "same_tx" | "same_funder" | "funded_directly" | "token_transfer";
export type LaunchWallet = { address: string; pct: number; heldPct: number; group: number | null; creator: boolean; reasons: LinkReason[] };
export type LaunchCheck = {
  status: "none" | "fast" | "linked";
  window_seconds: number;
  early_wallets: number;
  early_pct: number;
  linked_wallets: number;
  linked_pct: number;
  held_pct: number;
  creator_pct: number;
  wallets: LaunchWallet[];
};

export const REASON_LABEL: Record<LinkReason, string> = {
  same_tx: "Same transaction",
  same_funder: "Same funder",
  funded_directly: "Funded by another",
  token_transfer: "Moved tokens",
};

/** Null: not checked yet, or no buyers yet. */
export async function launchCheck(token: string): Promise<LaunchCheck | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/launch_checks?token=eq.${token.toLowerCase()}&select=summary`, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY } });
  if (!res.ok) return null;
  const [row] = (await res.json()) as { summary: LaunchCheck | null }[];
  return row?.summary ?? null;
}

/** Sample numbers, a different story per token. */
export function demoLaunchCheck(token: string): LaunchCheck {
  const seed = parseInt(token.slice(-2), 16) || 0;
  const a = (n: number) => `0x${(seed + n).toString(16).padStart(2, "0").repeat(20)}`;
  const base = { window_seconds: 60, creator_pct: 1.2 };
  if (seed % 3 === 0) {
    return {
      ...base,
      status: "fast",
      early_wallets: 3,
      early_pct: 2.4,
      linked_wallets: 0,
      linked_pct: 0,
      held_pct: 1.6,
      wallets: [
        { address: a(1), pct: 1.1, heldPct: 1.1, group: null, creator: false, reasons: [] },
        { address: a(2), pct: 0.8, heldPct: 0.5, group: null, creator: false, reasons: [] },
        { address: a(3), pct: 0.5, heldPct: 0, group: null, creator: false, reasons: [] },
      ],
    };
  }
  return {
    ...base,
    status: "linked",
    early_wallets: 6,
    early_pct: 14.6,
    linked_wallets: 4,
    linked_pct: 12.1,
    held_pct: 7.3,
    wallets: [
      { address: a(1), pct: 4.2, heldPct: 4.2, group: 1, creator: false, reasons: ["same_funder"] },
      { address: a(2), pct: 3.4, heldPct: 3.1, group: 1, creator: false, reasons: ["same_funder", "token_transfer"] },
      { address: a(3), pct: 2.6, heldPct: 0, group: 1, creator: false, reasons: ["same_tx"] },
      { address: a(4), pct: 1.9, heldPct: 0, group: 1, creator: false, reasons: ["same_tx"] },
      { address: a(5), pct: 1.5, heldPct: 1.5, group: null, creator: false, reasons: [] },
      { address: a(6), pct: 1, heldPct: 0.4, group: null, creator: false, reasons: [] },
    ],
  };
}
