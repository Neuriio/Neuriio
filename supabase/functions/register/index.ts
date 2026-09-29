// POST /functions/v1/register    headers: Authorization: Bearer <Privy access token>
// Call after every X login: creates/refreshes the user's row (X handle, pfp, Neuriio wallet) so their trades earn
// points even if they never launch. Returns the profile, their token (if launched) and their points.
//
// Secrets: PRIVY_APP_ID, PRIVY_APP_SECRET (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.)

import { createClient } from "npm:@supabase/supabase-js@2";
import { CORS, HttpError, json, privyAuth, userRow } from "../_shared/privy.ts";
import { env } from "../_shared/env.ts";


const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const xUserFromRequest = privyAuth(env("PRIVY_APP_ID"), env("PRIVY_APP_SECRET"));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  try {
    const who = await xUserFromRequest(req);
    const { error } = await db.from("users").upsert(userRow(who), { onConflict: "privy_id" });
    if (error) {
      console.error(`register: users upsert: ${error.message}`); // details stay server-side
      return json(500, { error: "Could not save your profile, try again" });
    }

    const [{ data: token }, { data: points }] = await Promise.all([
      db.from("tokens").select("*").eq("x_user_id", who.xUserId).maybeSingle(),
      db.from("leaderboard").select("rank, points").eq("x_user_id", who.xUserId).maybeSingle(),
    ]);
    return json(200, {
      xUserId: who.xUserId,
      handle: who.handle,
      name: who.name,
      pfpUrl: who.pfpUrl,
      wallet: who.wallet,
      token: token ?? null,
      points: points?.points ?? 0,
      rank: points?.rank ?? null,
    });
  } catch (e) {
    return json(e instanceof HttpError ? e.status : 500, { error: (e as Error).message });
  }
});
