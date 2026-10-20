-- Feed posts. Anyone can read; writes only through the `posts` Edge Function (Privy login, service role).
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  x_user_id text not null,
  x_handle text not null,
  x_name text,
  x_pfp_url text,
  wallet text not null,
  text text not null check (char_length(btrim(text)) between 1 and 280),
  created_at timestamptz not null default now()
);
create index posts_created_at_idx on public.posts (created_at desc);
create index posts_x_user_id_idx on public.posts (x_user_id, created_at desc);

alter table public.posts enable row level security;
create policy "posts are public" on public.posts for select to anon, authenticated using (true);
revoke insert, update, delete on public.posts from anon, authenticated;
