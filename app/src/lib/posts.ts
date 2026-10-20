// Feed posts: read from the public `posts` table, written through the `posts` Edge Function (Privy login).
import type { Address } from "viem";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

export type PostRow = {
  id: string;
  x_user_id: string;
  x_handle: string;
  x_name: string | null;
  x_pfp_url: string | null;
  wallet: Address;
  text: string;
  created_at: string;
};

export const POST_MAX = 280;

/** The newest posts, newest first. */
export async function latestPosts(limit = 100): Promise<PostRow[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?select=*&order=created_at.desc&limit=${limit}`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) throw new Error(`Posts: ${res.status}`);
  return res.json();
}

/** Posts `text` as the logged-in user. Throws the function's own message on failure. */
export async function createPost(getToken: () => Promise<string | null>, text: string): Promise<PostRow> {
  const token = await getToken();
  if (!token) throw new Error("Log in first");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", text }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Post failed (${res.status})`);
  return json.post as PostRow;
}
