// Feed posts, likes + comments: read from the public tables (posts_feed has the counts), written through the `posts` Edge Function (Privy login).
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
  likes: number;
  comments: number;
};

export type CommentRow = {
  id: string;
  post_id: string;
  x_user_id: string;
  x_handle: string;
  x_name: string | null;
  x_pfp_url: string | null;
  text: string;
  created_at: string;
};

export const POST_MAX = 280;

async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY } });
  if (!res.ok) throw new Error(`Posts: ${res.status}`);
  return res.json();
}

/** The newest posts, newest first, with like + comment counts. */
export const latestPosts = (limit = 100) => rest<PostRow[]>(`posts_feed?select=*&order=created_at.desc&limit=${limit}`);

/** A post's comments, oldest first. */
export const commentsOf = (postId: string) =>
  rest<CommentRow[]>(`post_comments?select=*&post_id=eq.${encodeURIComponent(postId)}&order=created_at.asc&limit=500`);

/** The posts this X account liked (ids). */
export const likedBy = async (xUserId: string) =>
  new Set((await rest<{ post_id: string }[]>(`post_likes?select=post_id&x_user_id=eq.${encodeURIComponent(xUserId)}`)).map((r) => r.post_id));

async function call<T>(getToken: () => Promise<string | null>, body: Record<string, unknown>): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Log in first");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

/** Posts `text` as the logged-in user. Throws the function's own message on failure. */
export const createPost = async (getToken: () => Promise<string | null>, text: string) =>
  (await call<{ post: PostRow }>(getToken, { action: "create", text })).post;

/** Likes (on) or unlikes a post; returns its new like count. */
export const likePost = async (getToken: () => Promise<string | null>, postId: string, on: boolean) =>
  (await call<{ likes: number }>(getToken, { action: "like", postId, on })).likes;

/** Comments on a post. */
export const commentOn = async (getToken: () => Promise<string | null>, postId: string, text: string) =>
  (await call<{ comment: CommentRow }>(getToken, { action: "comment", postId, text })).comment;
