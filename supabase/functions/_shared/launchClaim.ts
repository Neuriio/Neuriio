// Anti-vamping (user, 2026-11-01), checked before a pass is signed: the first to launch keeps its ticker's first 4 characters and its
// picture. The database refuses tickers and shortlists suspect pictures (claim_launch); pfpHash.ts confirms a suspect is a real copy.
// A signed pass holds both until it expires, so two people can't both get through at once: each only checks against earlier claims.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { confirmsCopy, PFP_HASH_BITS, type PfpHit, type PfpPrint } from "./pfpHash.ts";

export type LaunchClaim = {
  ticker: string;
  owners: string[]; // X user IDs: the creator, or an FTF's members
  pfp: PfpPrint | null; // null: no picture to compare, such as X's stock avatar
  deadline: Date;
  commit?: boolean; // false: only check, hold nothing
};

type Answer = {
  conflict: "ticker" | null;
  with?: string;
  launchpad?: string; // set when the coin it's too close to launched elsewhere and reached the vamp-watch market cap ($75k)
  claim?: number;
  suspects?: { ticker: string; thumb: string; hits: PfpHit[] }[];
};

/** Why this launch is refused, in words for the user, or null if it can go ahead. */
export async function claimLaunch(db: SupabaseClient, c: LaunchClaim): Promise<string | null> {
  const { data, error } = await db.rpc("claim_launch", {
    p_ticker: c.ticker,
    p_owners: c.owners,
    p_grid: c.pfp?.grid ?? null,
    p_mirror: c.pfp?.mirror ?? null,
    p_thumb: c.pfp?.thumb ?? null,
    p_max_bits: PFP_HASH_BITS,
    p_deadline: c.deadline.toISOString(),
    p_commit: c.commit ?? true,
  });
  if (error) throw new Error(`claim_launch: ${error.message}`);
  const answer = data as Answer;
  if (answer.conflict === "ticker") {
    const where = answer.launchpad ? `already trades on ${answer.launchpad}` : "launched first";
    return `$${c.ticker.toUpperCase()} is too close to $${answer.with}, which ${where}. Tickers can't share their first 4 characters`;
  }
  const copied = c.pfp && (answer.suspects ?? []).find((s) => confirmsCopy(c.pfp!.thumb, s.thumb, s.hits));
  if (!copied) return null;
  if (answer.claim) {
    const { error: e2 } = await db.from("launch_claims").delete().eq("id", answer.claim);
    if (e2) throw new Error(`release claim: ${e2.message}`);
  }
  return `This profile picture matches $${copied.ticker}, which launched first. Change the picture, log out and back in, then try again`;
}
