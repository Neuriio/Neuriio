-- Every Ascend token, not only ours (user, 2026-11-04): /trending ranks all of Ascend with our three tiers. Filled by the indexer's
-- "ascend_all" world from the Ascend launchpad's Launched events (any pair: USDC, HYPE, KNTQ, stocks), with token art from
-- Ascend's public metadata API. Their trades go in `trades` like ours, with `price_hype` and `usd_value` in USD for every pair.
create table public.ascend_tokens (
  address        text primary key,             -- lower case
  pool_id        text not null unique,         -- the Uniswap v4 pool id, lower case
  quote          text not null,                -- the pair asset, lower case
  quote_symbol   text,
  quote_decimals integer not null,
  name           text,
  symbol         text,
  supply         numeric not null default 1000000000, -- whole tokens
  fee_pips       integer,                      -- the pool's whole fee (10,000 = 1%)
  builder_fee_pips integer,
  launched_at    timestamptz not null,
  launch_block   bigint,
  launch_tx      text,
  image_cid      text,                         -- Ascend metadata (IPFS); null until published
  description    text,
  website        text,
  twitter        text,
  telegram       text,
  metadata_checked_at timestamptz              -- last time the indexer asked Ascend's metadata API
);
create index ascend_tokens_metadata on public.ascend_tokens (metadata_checked_at nulls first);
alter table public.ascend_tokens enable row level security;
create policy "ascend tokens are public" on public.ascend_tokens for select to anon, authenticated using (true);
grant select on public.ascend_tokens to anon, authenticated;
grant select, insert, update on public.ascend_tokens to service_role;

-- The same columns as token_stats (so the app reads it the same way), for every Ascend token, all in USD. `ours` marks a launch
-- through NeuriioLauncher (then the X account's name and picture show, as everywhere else); `token_name` is the coin's own name.
create view public.ascend_token_stats with (security_invoker = true) as
with t as (
  select market, ts, block_number, log_index, quote_amount, usd_value, price_hype
  from public.trades
  where venue = 'pool' and market in (select address from public.ascend_tokens)
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
)
select a.address,
       coalesce(k.handle, lower(a.symbol)) as handle,
       coalesce(k.symbol, a.symbol) as symbol,
       k.category,
       coalesce(k.creator, '') as creator,
       k.x_user_id,
       coalesce(u.x_name, case when k.address is null then a.name end) as x_name,
       coalesce(u.x_pfp_url, k.pfp_url,
                case when a.image_cid is not null then 'https://gateway.pinata.cloud/ipfs/' || a.image_cid end) as x_pfp_url,
       a.launched_at, true as graduated, a.pool_id as pair, a.launched_at as graduated_at,
       lp.price_hype,
       lp.price_hype * a.supply as mcap_hype,
       coalesce(pa.price_hype, lp.price_hype) as price_hype_24h_ago,
       1 as curve_progress,
       coalesce(g.trades, 0) as trades,
       coalesce(g.trades_24h, 0) as trades_24h,
       coalesce(g.volume_usd, 0) as volume_usd,
       coalesce(g.volume_usd_24h, 0) as volume_usd_24h,
       coalesce(g.volume_hype, 0) as volume_hype,
       g.last_trade_at,
       coalesce(k.kind, 'individual') as kind,
       k.name,
       k.member_x_user_ids,
       null::text as sector,
       k.launchpad,
       (k.address is not null) as ours,
       a.name as token_name,
       a.quote_symbol,
       a.quote
from public.ascend_tokens a
left join public.tokens k
       on k.address = a.address and k.registry is not distinct from (select value from public.app_config where key = 'registry')
left join public.user_cards u on u.x_user_id = k.x_user_id
left join agg g on g.market = a.address
left join last_price lp on lp.market = a.address
left join price_ago pa on pa.market = a.address;
grant select on public.ascend_token_stats to anon, authenticated;
