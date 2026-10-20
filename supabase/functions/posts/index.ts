// Feed posts (app/src/components/FeedCard.tsx). POST { action: "create", text } with the Privy access token:
// stores a post as the caller's X account + Neuriio wallet (read from Privy, never from the request).
// Reading is public: GET /rest/v1/posts (RLS: select only).
// Secrets: PRIVY_APP_ID, PRIVY_APP_SECRET

import { createClient } from "npm:@supabase/supabase-js@2";
import { CORS, HttpError, internalError, json, privyAuth, userRow } from "../_shared/privy.ts";
import { env } from "../_shared/env.ts";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const xUserFromRequest = privyAuth(env("PRIVY_APP_ID"), env("PRIVY_APP_SECRET"));

const POST_MAX = 280;
const POSTS_PER_MINUTE = 5; // per X account (per instance)
const recent = new Map<string, number[]>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  try {
    const who = await xUserFromRequest(req);
    let body: { action?: string; text?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Invalid JSON" });
    }
    if (body?.action !== "create") return json(400, { error: "Unknown action. One of: create" });
    const text = String(body.text ?? "").replace(/\r\n/g, "\n").trim();
    if (!text) throw new HttpError(422, "Write something first");
    if ([...text].length > POST_MAX) throw new HttpError(422, `Posts are ${POST_MAX} characters at most`);

    const now = Date.now();
    const times = (recent.get(who.xUserId) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= POSTS_PER_MINUTE) throw new HttpError(429, "Too many posts, slow down");
    recent.set(who.xUserId, [...times, now]);

    await db.from("users").upsert(userRow(who), { onConflict: "privy_id" });
    const { data, error } = await db
      .from("posts")
      .insert({ x_user_id: who.xUserId, x_handle: who.handle, x_name: who.name, x_pfp_url: who.pfpUrl, wallet: who.wallet.toLowerCase(), text })
      .select("*")
      .single();
    if (error) internalError("posts", "insert", error.message);
    return json(200, { post: data });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(`posts: ${(e as Error).message}`);
    return json(500, { error: "Something went wrong, try again" });
  }
});
