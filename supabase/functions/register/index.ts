// POST /functions/v1/register    headers: Authorization: Bearer <Privy access token>
// Call after every X login: creates/refreshes the user's row (X handle, pfp, Neuriio wallet) so their trades earn
// points even if they never launch. Returns the profile, their token (if launched) and their points.
//   body (optional): { accessCode } = the passcode they came in with (the passcode page's `neuriio_code` cookie); the
//   first one seen per user is kept in access_code_users, to count users per code.
//
// Secrets: PRIVY_APP_ID, PRIVY_APP_SECRET (SUPABASE_URL is provided by Supabase; NEURIIO_DB_KEY = the project's sb_secret key, set 2026-10-21 after the Railway leak.)

import { createClient } from "npm:@supabase/supabase-js@2";
import { CORS, HttpError, internalError, json, privyAuth, userRow } from "../_shared/privy.ts";
import { env } from "../_shared/env.ts";


const db = createClient(env("SUPABASE_URL"), env("NEURIIO_DB_KEY"), { auth: { persistSession: false } });
const xUserFromRequest = privyAuth(env("PRIVY_APP_ID"), env("PRIVY_APP_SECRET"));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  try {
    const who = await xUserFromRequest(req);
    const { error } = await db.from("users").upsert(userRow(who), { onConflict: "privy_id" });
    if (error) internalError("register", "users upsert", error.message);

    // which passcode they came in with (first one seen wins); never fails the login
    const body = await req.json().catch(() => ({}));
    const code = typeof body?.accessCode === "string" ? body.accessCode.trim() : "";
    if (code && code.length <= 64) {
      const { error: e2 } = await db.from("access_code_users").upsert(
        { x_user_id: who.xUserId, code },
        { onConflict: "x_user_id", ignoreDuplicates: true },
      );
      if (e2) console.error(`register: access code: ${e2.message}`);
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
