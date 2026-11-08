// Creator fees on Ascend (user, 2026-11-07): what a token's creator has earned, for our launches and Ascend's top tokens alike.
// The indexer (supabase/functions/indexer/creatorFees.ts) reads each token's CreatorEscrow every 5 minutes into creator_fees:
// the sum of its Credited payouts (Ascend pays creators automatically on each settle, so "claimable" is nearly always 0) plus
// what's held back below Ascend's $40k market cap. The app only reads that table: no RPC calls per visitor.
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

export type CreatorFees = {
  /** Lifetime creator earnings in USD (paid out + held), at the indexer's last run. */
  usd: number;
  /** The held part's share of it (0..1): forfeited if the token doesn't qualify within Ascend's 14 days. */
  heldShare: number;
};

/** A token's creator fees, or null when the indexer doesn't track it (yet). Kept a minute per token. */
const cache = new Map<string, { at: number; p: Promise<CreatorFees | null> }>();
export function creatorFees(token: string): Promise<CreatorFees | null> {
  const k = token.toLowerCase();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = fetch(`${SUPABASE_URL}/rest/v1/creator_fees?token=eq.${k}&select=earned_usd,credited,held`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  })
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: { earned_usd: number | string; credited: number | string; held: number | string }[]) => {
      const r = rows[0];
      if (!r) return null;
      const credited = Number(r.credited);
      const held = Number(r.held);
      return { usd: Number(r.earned_usd), heldShare: credited + held > 0 ? held / (credited + held) : 0 };
    })
    .catch(() => null);
  cache.set(k, { at: Date.now(), p });
  return p;
}
