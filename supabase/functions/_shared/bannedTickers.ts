// The ticker ban list (user, 2026-11-05): tickers nobody can launch through Neuriio, even when their X handle matches. The list
// is the banned_tickers table, edited by hand in Supabase's table editor; a trigger stores each ticker in upper case without "$".
// Checked wherever a launch pass is signed or an FTF picks its ticker. An exact match only: banning SCAM doesn't ban SCAMX.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/** A ticker as the list stores it: trimmed, upper case, no leading "$" (the same as the table's trigger). */
export function normalizeTicker(ticker: string): string {
  return ticker.trim().replace(/^\$/, "").toUpperCase();
}

/** True if this ticker is on the ban list. A database error throws, so a failed lookup never lets a launch through. */
export async function tickerBanned(db: SupabaseClient, ticker: string): Promise<boolean> {
  const { data, error } = await db.from("banned_tickers").select("ticker").eq("ticker", normalizeTicker(ticker)).maybeSingle();
  if (error) throw new Error(`banned_tickers: ${error.message}`);
  return data !== null;
}

/** What the user is told. It doesn't say why: the reason column is for us. */
export const bannedMessage = (ticker: string) => `$${normalizeTicker(ticker)} can't be launched on Neuriio`;
