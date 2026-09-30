-- Upgrade-safe launching (2026-09-30). The chain now has a permanent LaunchRegistry with swappable Launchpad versions
-- (see src/launch/LaunchRegistry.sol). Here:
--   - every token records its Launchpad version and its registry
--   - "one personal token per X account" is per registry (the registry itself enforces it on-chain across every
--     Launchpad version), so a brand-new registry (a full testnet reset) never collides with old rows again
--   - app_config.registry = the registry the app shows (the indexer writes it from its REGISTRY_ADDRESS secret);
--     token_stats (Explore, Top 25, search, balances) only lists that registry's tokens. Rows from before the
--     registry (registry null) show only until a registry is configured.

alter table public.tokens add column launchpad text;
alter table public.tokens add column registry text;

drop index if exists public.tokens_one_per_x_user;
create unique index tokens_one_per_x_user on public.tokens (registry, x_user_id) where kind = 'individual';

create table public.app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;
create policy "app config is public" on public.app_config for select using (true);
grant select on public.app_config to anon, authenticated;

-- token_stats: same columns as before + launchpad (appended); only the current registry's tokens
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
where k.registry is not distinct from (select value from public.app_config where key = 'registry');
grant select on public.token_stats to anon, authenticated;
