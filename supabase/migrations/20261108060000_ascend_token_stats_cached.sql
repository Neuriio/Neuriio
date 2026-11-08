-- ascend_token_stats, cached (2026-11-08). The view recomputed every Ascend coin's stats from ALL trades (76k rows, two sorts that
-- spilled to disk) on every request: ~3.3 s, past the 3 s limit for public requests, so Explore's list, the footer and Swap timed out
-- (500) or took 25 s once trading picked up. Now the same calculation runs once a minute (pg_cron) into a materialized view under the
-- same name and columns, and every reader gets the stored copy instantly. Stats can be up to a minute old; live trades still move the
-- chart and price in the app (Realtime / record-trade).

-- the calculation itself, unchanged, under a new name; only the refresh reads it
alter view public.ascend_token_stats rename to ascend_token_stats_live;
revoke all on public.ascend_token_stats_live from anon, authenticated;

create materialized view public.ascend_token_stats as select * from public.ascend_token_stats_live;
create unique index ascend_token_stats_address on public.ascend_token_stats (address); -- needed for a concurrent refresh
create index ascend_token_stats_volume_24h on public.ascend_token_stats (volume_usd_24h desc);
create index ascend_token_stats_volume on public.ascend_token_stats (volume_usd desc);
create index ascend_token_stats_mcap on public.ascend_token_stats (mcap_hype);
grant select on public.ascend_token_stats to anon, authenticated, service_role;

-- every minute; "concurrently" keeps it readable during the refresh
select cron.schedule('neuriio-ascend-token-stats', '* * * * *', $$refresh materialized view concurrently public.ascend_token_stats$$);

notify pgrst, 'reload schema';
