-- Explore's left card: Top 25 launched tokens by TOTAL (all-time) USD volume, re-ranked every 30 minutes by pg_cron,
-- so the list order holds still between scans. The numbers shown (market cap, 24h change) stay live via token_stats.

create table public.top_tokens (
  rank         integer primary key,
  address      text not null,
  volume_usd   numeric not null,   -- all-time volume at the snapshot
  snapshot_at  timestamptz not null
);
alter table public.top_tokens enable row level security;
create policy "top tokens are public" on public.top_tokens for select using (true);

create or replace function public.refresh_top_tokens() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from top_tokens;
  insert into top_tokens (rank, address, volume_usd, snapshot_at)
  select row_number() over (order by s.volume_usd desc, s.launched_at asc), s.address, s.volume_usd, now()
    from token_stats s
   order by s.volume_usd desc, s.launched_at asc
   limit 25;
end $$;
revoke all on function public.refresh_top_tokens() from public, anon, authenticated;

-- Snapshot order + live stats, for the app.
create view public.top_tokens_live with (security_invoker = true) as
  select t.rank, t.snapshot_at, t.volume_usd as snapshot_volume_usd, s.*
    from public.top_tokens t
    join public.token_stats s on s.address = t.address
   order by t.rank;
grant select on public.top_tokens_live to anon, authenticated;

select cron.schedule('neuriio-top-tokens', '*/30 * * * *', $$ select public.refresh_top_tokens() $$);
select public.refresh_top_tokens();
