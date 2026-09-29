-- FTF launch flow (user, 2026-09-29): the founder names the FTF and invites 3 people first; category, bio, links and
-- the FTF's own picture come AFTER all 4 accepted (same steps as a personal launch, "Category" instead of
-- "Who you are"). Invites are answered from a notifications window (an off-chain "yes", not a transaction).

alter table public.ftf_drafts alter column profile drop not null;       -- set later by the `profile` action
alter table public.ftf_drafts alter column profile_hash drop not null;
alter table public.ftf_drafts add column category public.creator_category;
alter table public.ftf_drafts add column pfp_url text;                  -- the FTF's picture (Storage: ftf-pfp)

-- launched FTFs keep their picture + category (individuals use their X picture via user_cards)
alter table public.tokens add column pfp_url text;

-- token_stats: an FTF's picture comes from tokens.pfp_url (same columns as before)
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
       k.kind, k.name, k.member_x_user_ids
from public.tokens k
left join public.user_cards u using (x_user_id)
left join agg a on a.market = k.address
left join last_price lp on lp.market = k.address
left join price_ago pa on pa.market = k.address
left join curve c on c.market = k.address;
grant select on public.token_stats to anon, authenticated;

-- FTF pictures: public to read, written only by the `ftf` function (service role; no insert policy for anyone else)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ftf-pfp', 'ftf-pfp', true, 524288, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;
