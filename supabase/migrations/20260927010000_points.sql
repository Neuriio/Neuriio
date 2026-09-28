-- Points: rates per venue, idempotent awarding from `trades` / `tokens`, live leaderboard, and the
-- every-minute schedule that runs the indexer Edge Function.

-- Tokens launched under a test signer have no thesis row: keep the hash, drop the hard link.
alter table public.tokens drop constraint if exists tokens_thesis_hash_fkey;

-- ------------------------------------------------------------------ rules

-- Rates can change any time; points already in the ledger never change.
create table public.points_rules (
  key         text primary key,     -- 'volume:<venue>' (points per $1 traded) or 'launch' (flat)
  points      numeric not null,
  note        text,
  updated_at  timestamptz not null default now()
);
alter table public.points_rules enable row level security;
create policy "points rules are public" on public.points_rules for select using (true);

insert into public.points_rules (key, points, note) values
  ('volume:curve',      0.0001,   '100 points per $1M traded (launched tokens, bonding curve)'),
  ('volume:pool',       0.0001,   '100 points per $1M traded (launched tokens, graduated pool)'),
  ('volume:hl_perp',    0.000075, '75 points per $1M traded (Hyperliquid perps via Neuriio)'),
  ('volume:hl_spot',    0.000075, '75 points per $1M traded (Hyperliquid spot via Neuriio)'),
  ('volume:hl_outcome', 0.000075, '75 points per $1M traded (Hyperliquid outcomes via Neuriio)'),
  ('launch',            50,       'launching yourself (once)');

-- ------------------------------------------------------------------ awarding

-- Links trades to users by wallet, then writes one ledger row per trade and per launch. Safe to run any time:
-- the ledger's unique (reason, ref, x_user_id) makes every award happen once. Returns rows inserted.
create or replace function public.award_points() returns integer
language plpgsql security definer set search_path = public as $$
declare n1 integer; n2 integer;
begin
  update trades t set x_user_id = u.x_user_id
    from users u where t.x_user_id is null and t.trader = u.wallet;

  insert into points_ledger (x_user_id, points, reason, ref)
    select t.x_user_id, t.usd_value * r.points, 'trade', t.id::text
    from trades t
    join points_rules r on r.key = 'volume:' || t.venue::text
    join users u on u.x_user_id = t.x_user_id
    where t.usd_value is not null and t.usd_value > 0
  on conflict (reason, ref, x_user_id) do nothing;
  get diagnostics n1 = row_count;

  insert into points_ledger (x_user_id, points, reason, ref)
    select k.x_user_id, r.points, 'launch', k.address
    from tokens k
    join users u on u.x_user_id = k.x_user_id
    join points_rules r on r.key = 'launch'
  on conflict (reason, ref, x_user_id) do nothing;
  get diagnostics n2 = row_count;

  return n1 + n2;
end $$;
revoke all on function public.award_points() from public, anon, authenticated;

-- ------------------------------------------------------------------ leaderboard

create or replace view public.leaderboard as
  select rank() over (order by sum(l.points) desc) as rank,
         u.x_user_id, u.x_handle, u.x_name, u.x_pfp_url,
         sum(l.points) as points,
         sum(l.points) filter (where l.reason = 'trade') as trading_points,
         sum(l.points) filter (where l.reason = 'launch') as launch_points
  from points_ledger l join users u using (x_user_id)
  group by u.x_user_id, u.x_handle, u.x_name, u.x_pfp_url;
grant select on public.leaderboard to anon, authenticated;

-- ------------------------------------------------------------------ indexer run lock

-- True if this caller may run now (no run started in the last 50 s); records the start time.
create or replace function public.try_lock_indexer() returns boolean
language plpgsql security definer set search_path = public as $$
declare got boolean;
begin
  insert into indexer_state (key, value) values ('lock', '0') on conflict (key) do nothing;
  update indexer_state set value = extract(epoch from now())::text, updated_at = now()
    where key = 'lock' and value::numeric < extract(epoch from now()) - 50
    returning true into got;
  return coalesce(got, false);
end $$;

create or replace function public.unlock_indexer() returns void
language sql security definer set search_path = public as $$
  update indexer_state set value = '0', updated_at = now() where key = 'lock';
$$;
revoke all on function public.try_lock_indexer() from public, anon, authenticated;
revoke all on function public.unlock_indexer() from public, anon, authenticated;

-- ------------------------------------------------------------------ schedule

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The indexer is idempotent and self-throttled, so its URL can be public (no secret in this file).
select cron.schedule(
  'neuriio-indexer',
  '* * * * *',
  $$ select net.http_post(
       url := 'https://yviymgfgaepmtijgyyyo.supabase.co/functions/v1/indexer',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb,
       timeout_milliseconds := 55000
     ) $$
);
