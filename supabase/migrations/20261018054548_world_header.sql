-- Two testnet worlds at once (2026-10-17): the live app still lists the HYPE world while the USDC app is built and
-- tested against the same database. A request can now name the world it wants with the header
-- `x-neuriio-registry: <LaunchRegistry address>`; without it, app_config.registry decides as before. So the live app
-- (no header) is unchanged, and the USDC app (sends its registry) lists the USDC world. Read-only, public data.
--   - app_registry(): the registry this request lists
--   - token_stats: filters by app_registry() (columns unchanged, so trending_tokens etc. are untouched)
--   - top_tokens: one Top 25 snapshot per registry (the cron ranks each world); top_tokens_live shows the request's

create or replace function public.app_registry() returns text
language sql stable set search_path = public as $$
  select coalesce(
    nullif(lower(nullif(current_setting('request.headers', true), '')::json ->> 'x-neuriio-registry'), ''),
    (select value from public.app_config where key = 'registry')
  );
$$;
grant execute on function public.app_registry() to anon, authenticated;

create or replace view public.token_stats with (security_invoker = true) as
with t as (
  select market, ts, block_number, log_index, venue, quote_amount, usd_value, price_hype, curve_sold
  from public.trades
  where venue in ('curve', 'pool')
),
agg as (
  select market,
         count(*) as trades,
         count(*) filter (where ts > now() - interval '24 hours') as trades_24h,
         coalesce(sum(usd_value), 0) as volume_usd,
         coalesce(sum(usd_value) filter (where ts > now() - interval '24 hours'), 0) as volume_usd_24h,
         coalesce(sum(quote_amount), 0) as volume_hype,
         max(ts) as last_trade_at
  from t group by market
),
last_price as (
  select distinct on (market) market, price_hype
  from t where price_hype is not null
  order by market, ts desc, block_number desc, log_index desc
),
price_ago as (
  select distinct on (market) market, price_hype
  from t where price_hype is not null and ts <= now() - interval '24 hours'
  order by market, ts desc, block_number desc, log_index desc
),
curve as (
  select distinct on (market) market, curve_sold
  from t where venue = 'curve' and curve_sold is not null
  order by market, ts desc, block_number desc, log_index desc
)
select k.address, k.handle, k.symbol, k.category, k.creator, k.x_user_id,
       u.x_name, coalesce(u.x_pfp_url, k.pfp_url) as x_pfp_url,
       k.launched_at, k.graduated, k.pair, k.graduated_at,
       coalesce(lp.price_hype, k.virtual_hype / 1073000000) as price_hype,
       coalesce(lp.price_hype, k.virtual_hype / 1073000000) * 1000000000 as mcap_hype,
       coalesce(pa.price_hype, k.virtual_hype / 1073000000) as price_hype_24h_ago,
       case when k.graduated then 1 else least(coalesce(c.curve_sold, 0) / 793100000, 1) end as curve_progress,
       coalesce(a.trades, 0) as trades,
       coalesce(a.trades_24h, 0) as trades_24h,
       coalesce(a.volume_usd, 0) as volume_usd,
       coalesce(a.volume_usd_24h, 0) as volume_usd_24h,
       coalesce(a.volume_hype, 0) as volume_hype,
       a.last_trade_at,
       k.kind, k.name, k.member_x_user_ids,
       (select cp.content::jsonb ->> 'sector' from public.creator_profiles cp where cp.hash = k.profile_hash) as sector,
       k.launchpad
from public.tokens k
left join public.user_cards u using (x_user_id)
left join agg a on a.market = k.address
left join last_price lp on lp.market = k.address
left join price_ago pa on pa.market = k.address
left join curve c on c.market = k.address
where k.registry is not distinct from public.app_registry();
grant select on public.token_stats to anon, authenticated;

-- Top 25: a snapshot per registry. The view depends on the table, so it's rebuilt around the new key.
drop view public.top_tokens_live;
alter table public.top_tokens add column registry text;
alter table public.top_tokens drop constraint top_tokens_pkey;
delete from public.top_tokens where rank is not null;
alter table public.top_tokens add constraint top_tokens_pkey unique nulls not distinct (registry, rank);

-- ranks each world in turn: token_stats lists the world named in request.headers, set here for the transaction
create or replace function public.refresh_top_tokens() returns void
language plpgsql security definer set search_path = public as $$
declare
  r text;
begin
  delete from top_tokens where rank is not null;
  for r in select distinct registry from tokens where registry is not null loop
    perform set_config('request.headers', json_build_object('x-neuriio-registry', r)::text, true);
    insert into top_tokens (registry, rank, address, volume_usd, snapshot_at)
    select r, row_number() over (order by s.volume_usd desc, s.launched_at asc), s.address, s.volume_usd, now()
      from token_stats s
     order by s.volume_usd desc, s.launched_at asc
     limit 25;
  end loop; -- (the setting is local to this transaction)
end $$;
revoke all on function public.refresh_top_tokens() from public, anon, authenticated;

-- snapshot order + live stats, for the request's world
create view public.top_tokens_live with (security_invoker = true) as
  select t.rank, t.snapshot_at, t.volume_usd as snapshot_volume_usd, s.*
    from public.top_tokens t
    join public.token_stats s on s.address = t.address
   where t.registry is not distinct from public.app_registry()
   order by t.rank;
grant select on public.top_tokens_live to anon, authenticated;

select public.refresh_top_tokens();
