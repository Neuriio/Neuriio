// Rate limits kept in the database (migration rate_limits: hit_rate_limit), so they hold across every function
// instance and restart, unlike an in-memory counter. Needs the secret-key client (the function is server-only).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { HttpError, internalError } from "./privy.ts";

/** Records one hit for `key`; throws 429 when it already had `limit` hits in the last `windowS` seconds. */
export async function rateLimit(
  db: SupabaseClient,
  fn: string,
  key: string,
  limit: number,
  windowS: number,
  message = "Too many, slow down",
) {
  const { data, error } = await db.rpc("hit_rate_limit", { p_key: key, p_limit: limit, p_window_s: windowS });
  if (error) internalError(fn, "rate limit", error.message);
  if (data !== true) throw new HttpError(429, message);
}
