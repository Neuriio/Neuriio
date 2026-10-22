-- Feed likes + comments. Public read; writes only through the `posts` Edge Function (service role).
create table public.post_likes (
  post_id uuid not null references public.posts (id) on delete cascade,
  x_user_id text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, x_user_id)
);
create index post_likes_x_user_id_idx on public.post_likes (x_user_id);

create table public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  x_user_id text not null,
  x_handle text not null,
  x_name text,
  x_pfp_url text,
  text text not null check (char_length(btrim(text)) between 1 and 280),
  created_at timestamptz not null default now()
);
create index post_comments_post_idx on public.post_comments (post_id, created_at);

alter table public.post_likes enable row level security;
alter table public.post_comments enable row level security;
create policy "likes are public" on public.post_likes for select to anon, authenticated using (true);
create policy "comments are public" on public.post_comments for select to anon, authenticated using (true);
revoke insert, update, delete on public.post_likes, public.post_comments from anon, authenticated;

-- posts with their counts, for the feed
create view public.posts_feed with (security_invoker = true) as
select p.*,
  (select count(*) from public.post_likes l where l.post_id = p.id)::int as likes,
  (select count(*) from public.post_comments c where c.post_id = p.id)::int as comments
from public.posts p;
grant select on public.posts_feed to anon, authenticated;
