-- Explore page: per-token stats (search, top lists, details) and price history (chart). Public read-only.

-- Filled by the indexer from here on (the tables were empty when this shipped).
alter table public.trades add column price_hype numeric; -- curve/pool: spot HYPE per token right after the trade
alter table public.trades add column curve_sold numeric; -- curve: tokens sold from the curve after the trade
alter table public.tokens add column virtual_hype numeric; -- Launched.virtualHype; opening price = virtual_hype / 1.073B

-- One row per launched token. Prices are in HYPE (the app converts with the live HYPE price); volumes in USD are
-- valued at each trade's time. Order/filter it through the REST API, e.g. top 25: order=volume_usd_24h.desc&limit=25,
-- search: handle=ilike.*von*.
create view public.token_stats with (security_invoker = true) as
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
-- the price 24 h ago = the last one before then; with no trade before then it was still the opening price
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
       u.x_name, u.x_pfp_url,
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
       a.last_trade_at
from public.tokens k
left join public.user_cards u using (x_user_id)
left join agg a on a.market = k.address
left join last_price lp on lp.market = k.address
left join price_ago pa on pa.market = k.address
left join curve c on c.market = k.address;
grant select on public.token_stats to anon, authenticated;

-- OHLC candles for one token (chart). A trade's price is the price AFTER it, so a candle opens at the price before
-- its first trade (the previous close, or the opening price). Bucket >= 60 s; p_since null = all history.
create or replace function public.token_candles(p_token text, p_bucket_seconds integer default 300, p_since timestamptz default null)
returns table (bucket timestamptz, open numeric, high numeric, low numeric, close numeric,
               volume_hype numeric, volume_usd numeric, trades bigint)
language sql stable security invoker set search_path = public as $$
  with tr as (
    select x.ts, x.block_number, x.log_index, x.price_hype, x.quote_amount, x.usd_value,
           coalesce(lag(x.price_hype) over (order by x.ts, x.block_number, x.log_index),
                    (select k.virtual_hype / 1073000000 from tokens k where k.address = lower(p_token))) as prev
    from trades x
    where x.market = lower(p_token) and x.venue in ('curve', 'pool') and x.price_hype is not null
  ),
  b as (
    select to_timestamp(floor(extract(epoch from tr.ts) / greatest(p_bucket_seconds, 60)) * greatest(p_bucket_seconds, 60)) as b_t, tr.*
    from tr where p_since is null or tr.ts >= p_since
  )
  select b_t,
         (array_agg(prev order by ts, block_number, log_index))[1],
         greatest(max(price_hype), (array_agg(prev order by ts, block_number, log_index))[1]),
         least(min(price_hype), (array_agg(prev order by ts, block_number, log_index))[1]),
         (array_agg(price_hype order by ts desc, block_number desc, log_index desc))[1],
         sum(quote_amount), sum(usd_value), count(*)
  from b group by b_t order by b_t
  limit 5000;
$$;
grant execute on function public.token_candles(text, integer, timestamptz) to anon, authenticated;
