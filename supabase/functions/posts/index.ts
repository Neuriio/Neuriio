// Feed posts (app/src/components/FeedCard.tsx), with the Privy access token; the caller's X account + Neuriio wallet
// are read from Privy, never from the request.
//   create  { text }                -> { post }      a post (280 chars)
//   like    { postId, on }          -> { likes }     like / unlike
//   comment { postId, text }        -> { comment }   a comment (280 chars)
// Reading is public: /rest/v1/posts_feed (counts), post_likes, post_comments (RLS: select only).
// Secrets: PRIVY_APP_ID, PRIVY_APP_SECRET

import { createClient } from "npm:@supabase/supabase-js@2";
import { CORS, HttpError, internalError, json, privyAuth, userRow } from "../_shared/privy.ts";
import { env } from "../_shared/env.ts";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const xUserFromRequest = privyAuth(env("PRIVY_APP_ID"), env("PRIVY_APP_SECRET"));

const POST_MAX = 280;
const PER_MINUTE = { create: 5, comment: 10, like: 60 } as Record<string, number>; // per X account (per instance)
const recent = new Map<string, number[]>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  try {
    const who = await xUserFromRequest(req);
    let body: { action?: string; text?: unknown; postId?: unknown; on?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Invalid JSON" });
    }
    const action = String(body?.action);
    if (!(action in PER_MINUTE)) return json(400, { error: "Unknown action. One of: create, like, comment" });

    const now = Date.now();
    const key = `${action}:${who.xUserId}`;
    const times = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= PER_MINUTE[action]) throw new HttpError(429, "Too many, slow down");
    recent.set(key, [...times, now]);

    if (action === "like") {
      const postId = String(body.postId ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(postId)) throw new HttpError(422, "Unknown post");
      const { error } = body.on
        ? await db.from("post_likes").upsert({ post_id: postId, x_user_id: who.xUserId }, { onConflict: "post_id,x_user_id", ignoreDuplicates: true })
        : await db.from("post_likes").delete().eq("post_id", postId).eq("x_user_id", who.xUserId);
      if (error?.code === "23503") throw new HttpError(404, "That post is gone");
      if (error) internalError("posts", "like", error.message);
      const { count } = await db.from("post_likes").select("post_id", { count: "exact", head: true }).eq("post_id", postId);
      return json(200, { likes: count ?? 0 });
    }

    const text = String(body.text ?? "").replace(/\r\n/g, "\n").trim();
    if (!text) throw new HttpError(422, "Write something first");
    if ([...text].length > POST_MAX) throw new HttpError(422, `${POST_MAX} characters at most`);
    await db.from("users").upsert(userRow(who), { onConflict: "privy_id" });

    if (action === "comment") {
      const postId = String(body.postId ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(postId)) throw new HttpError(422, "Unknown post");
      const { data, error } = await db
        .from("post_comments")
        .insert({ post_id: postId, x_user_id: who.xUserId, x_handle: who.handle, x_name: who.name, x_pfp_url: who.pfpUrl, text })
        .select("*")
        .single();
      if (error?.code === "23503") throw new HttpError(404, "That post is gone");
      if (error) internalError("posts", "comment", error.message);
      return json(200, { comment: data });
    }

    const { data, error } = await db
      .from("posts")
      .insert({ x_user_id: who.xUserId, x_handle: who.handle, x_name: who.name, x_pfp_url: who.pfpUrl, wallet: who.wallet.toLowerCase(), text })
      .select("*")
      .single();
    if (error) internalError("posts", "insert", error.message);
    return json(200, { post: { ...data, likes: 0, comments: 0 } });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(`posts: ${(e as Error).message}`);
    return json(500, { error: "Something went wrong, try again" });
  }
});
