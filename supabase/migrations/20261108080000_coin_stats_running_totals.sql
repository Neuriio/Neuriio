-- Coin stats as running totals (user, 2026-11-08: "this should not reread on every single load").
-- Before: token_stats and ascend_token_stats added up the trades table on every read (77k rows, sorts on disk), which saturated the
-- database once the site went live. Now:
--   coin_stats       one row per coin: all-time trades / volume, last trade, last price, last curve position, and the 24h numbers.
--   trigger          every insert into trades (the indexer and record-trade insert with ON CONFLICT DO NOTHING, so the trigger
--                    sees each new trade exactly once) adds to the totals; prices only move forward (by ts, block, log index), so
--                    out-of-order backfills can't put an old price on top.
--   minute job       recomputes only the 24h numbers from the last 24h of trades (index trades_pool_ts) and the price 24h ago
--                    (index trades_market_ts). New trades already count in the 24h numbers when inserted; the job rolls old ones out.
--   views            token_stats and ascend_token_stats keep their names and columns and read coin_stats: no trades scan per read.
-- If trades are ever deleted or edited by hand (rare: an archive), run `select public.coin_stats_rebuild();` once.
-- Run as ONE transaction (the SQL editor does): trades is locked for writes while the totals are first filled, so no trade is
-- counted twice or missed. The indexer just waits a few seconds.

begin;

lock table public.trades in share row exclusive mode;

create table public.coin_stats (
  market text primary key,
  trades bigint not null default 0,
  volume_usd numeric not null default 0,
  volume_hype numeric not null default 0,
  last_trade_at timestamptz,
  price_hype numeric,               -- price of the latest priced trade
  price_ts timestamptz,
  price_block bigint,
  price_log integer,
  curve_sold numeric,               -- curve position after the latest curve trade (our old curve launches)
  curve_ts timestamptz,
  curve_block bigint,
  curve_log integer,
  trades_24h bigint not null default 0,
  volume_usd_24h numeric not null default 0,
  price_hype_24h_ago numeric,       -- latest priced trade at or before 24h ago; null = none
  updated_at timestamptz not null default now()
);
alter table public.coin_stats enable row level security;
create policy coin_stats_read on public.coin_stats for select to anon, authenticated using (true);
grant select on public.coin_stats to anon, authenticated;
grant all on public.coin_stats to service_role;

create index if not exists trades_pool_ts on public.trades (ts) where venue in ('curve', 'pool');

-- (ts, block, log) as one sortable key; nulls sort lowest
create or replace function public.trade_key(ts timestamptz, block bigint, log integer) returns text
language sql immutable as $$
  select to_char(ts at time zone 'UTC', 'YYYYMMDDHH24MISSUS') || lpad(coalesce(block, -1)::text, 20, '0') || lpad(coalesce(log, -1)::text, 10, '0')
$$;

-- adds a batch of trades (rows of public.trades) to the totals
create or replace function public.coin_stats_add_rows(rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  with r as (
    select * from jsonb_populate_recordset(null::public.trades, rows) where venue in ('curve', 'pool')
  ), a as (
    select market,
      count(*) n,
      coalesce(sum(usd_value), 0) vu,
      coalesce(sum(quote_amount), 0) vh,
      max(ts) last_ts,
      count(*) filter (where ts > now() - interval '24 hours') n24,
      coalesce(sum(usd_value) filter (where ts > now() - interval '24 hours'), 0) vu24
    from r group by market
  ), p as (
    select distinct on (market) market, price_hype, ts, block_number, log_index
    from r where price_hype is not null
    order by market, trade_key(ts, block_number, log_index) desc
  ), c as (
    select distinct on (market) market, curve_sold, ts, block_number, log_index
    from r where venue = 'curve' and curve_sold is not null
    order by market, trade_key(ts, block_number, log_index) desc
  )
  insert into coin_stats as s (market, trades, volume_usd, volume_hype, last_trade_at, price_hype, price_ts, price_block, price_log,
                               curve_sold, curve_ts, curve_block, curve_log, trades_24h, volume_usd_24h, updated_at)
  select a.market, a.n, a.vu, a.vh, a.last_ts, p.price_hype, p.ts, p.block_number, p.log_index,
         c.curve_sold, c.ts, c.block_number, c.log_index, a.n24, a.vu24, now()
  from a left join p using (market) left join c using (market)
  on conflict (market) do update set
    trades = s.trades + excluded.trades,
    volume_usd = s.volume_usd + excluded.volume_usd,
    volume_hype = s.volume_hype + excluded.volume_hype,
    last_trade_at = greatest(s.last_trade_at, excluded.last_trade_at),
    trades_24h = s.trades_24h + excluded.trades_24h,
    volume_usd_24h = s.volume_usd_24h + excluded.volume_usd_24h,
    price_hype  = case when excluded.price_ts is not null and (s.price_ts is null or trade_key(excluded.price_ts, excluded.price_block, excluded.price_log) > trade_key(s.price_ts, s.price_block, s.price_log)) then excluded.price_hype  else s.price_hype  end,
    price_block = case when excluded.price_ts is not null and (s.price_ts is null or trade_key(excluded.price_ts, excluded.price_block, excluded.price_log) > trade_key(s.price_ts, s.price_block, s.price_log)) then excluded.price_block else s.price_block end,
    price_log   = case when excluded.price_ts is not null and (s.price_ts is null or trade_key(excluded.price_ts, excluded.price_block, excluded.price_log) > trade_key(s.price_ts, s.price_block, s.price_log)) then excluded.price_log   else s.price_log   end,
    price_ts    = case when excluded.price_ts is not null and (s.price_ts is null or trade_key(excluded.price_ts, excluded.price_block, excluded.price_log) > trade_key(s.price_ts, s.price_block, s.price_log)) then excluded.price_ts    else s.price_ts    end,
    curve_sold  = case when excluded.curve_ts is not null and (s.curve_ts is null or trade_key(excluded.curve_ts, excluded.curve_block, excluded.curve_log) > trade_key(s.curve_ts, s.curve_block, s.curve_log)) then excluded.curve_sold  else s.curve_sold  end,
    curve_block = case when excluded.curve_ts is not null and (s.curve_ts is null or trade_key(excluded.curve_ts, excluded.curve_block, excluded.curve_log) > trade_key(s.curve_ts, s.curve_block, s.curve_log)) then excluded.curve_block else s.curve_block end,
    curve_log   = case when excluded.curve_ts is not null and (s.curve_ts is null or trade_key(excluded.curve_ts, excluded.curve_block, excluded.curve_log) > trade_key(s.curve_ts, s.curve_block, s.curve_log)) then excluded.curve_log   else s.curve_log   end,
    curve_ts    = case when excluded.curve_ts is not null and (s.curve_ts is null or trade_key(excluded.curve_ts, excluded.curve_block, excluded.curve_log) > trade_key(s.curve_ts, s.curve_block, s.curve_log)) then excluded.curve_ts    else s.curve_ts    end,
    updated_at = now();
end $$;

create or replace function public.coin_stats_on_trades() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform coin_stats_add_rows((select coalesce(jsonb_agg(to_jsonb(n)), '[]'::jsonb) from new_rows n));
  return null;
end $$;

-- the 24h numbers, exact: trades in the last 24h (index trades_pool_ts) and the price 24h ago (index trades_market_ts). Coins with
-- no trade in the last 24h get 0 / 0 and their current price as the price 24h ago (the same as the old views gave).
create or replace function public.coin_stats_24h() returns void
language plpgsql security definer set search_path = public as $$
begin
  with recent as (
    select market, count(*) n, coalesce(sum(usd_value), 0) vu
    from trades where venue in ('curve', 'pool') and ts > now() - interval '24 hours'
    group by market
  ), x as (
    select s2.market, r.n, r.vu, (r.market is not null) active,
      case when r.market is not null then (
        select t.price_hype from trades t
        where t.market = s2.market and t.venue in ('curve', 'pool') and t.price_hype is not null and t.ts <= now() - interval '24 hours'
        order by t.ts desc, t.block_number desc nulls last, t.log_index desc nulls last limit 1
      ) end p_ago
    from coin_stats s2 left join recent r on r.market = s2.market
  )
  update coin_stats s set
    trades_24h = coalesce(x.n, 0),
    volume_usd_24h = coalesce(x.vu, 0),
    price_hype_24h_ago = case when x.active then x.p_ago else s.price_hype end,
    updated_at = now()
  from x
  where x.market = s.market
    and (s.trades_24h is distinct from coalesce(x.n, 0)
      or s.volume_usd_24h is distinct from coalesce(x.vu, 0)
      or s.price_hype_24h_ago is distinct from (case when x.active then x.p_ago else s.price_hype end));
end $$;

-- from scratch (first fill, and if trades are ever deleted or edited by hand)
create or replace function public.coin_stats_rebuild() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from coin_stats;
  insert into coin_stats (market, trades, volume_usd, volume_hype, last_trade_at)
  select market, count(*), coalesce(sum(usd_value), 0), coalesce(sum(quote_amount), 0), max(ts)
  from trades where venue in ('curve', 'pool') group by market;
  update coin_stats s set price_hype = p.price_hype, price_ts = p.ts, price_block = p.block_number, price_log = p.log_index
  from (select distinct on (market) market, price_hype, ts, block_number, log_index from trades
        where venue in ('curve', 'pool') and price_hype is not null
        order by market, ts desc, block_number desc nulls last, log_index desc nulls last) p
  where p.market = s.market;
  update coin_stats s set curve_sold = c.curve_sold, curve_ts = c.ts, curve_block = c.block_number, curve_log = c.log_index
  from (select distinct on (market) market, curve_sold, ts, block_number, log_index from trades
        where venue = 'curve' and curve_sold is not null
        order by market, ts desc, block_number desc nulls last, log_index desc nulls last) c
  where c.market = s.market;
  perform coin_stats_24h();
end $$;

revoke all on function public.coin_stats_add_rows(jsonb), public.coin_stats_24h(), public.coin_stats_rebuild() from public, anon, authenticated;

select public.coin_stats_rebuild();

create trigger trades_coin_stats after insert on public.trades
  referencing new table as new_rows for each statement execute function public.coin_stats_on_trades();

-- the 24h roll-off, every minute (replaces the full refresh)
select cron.unschedule('neuriio-ascend-token-stats');
select cron.schedule('neuriio-coin-stats-24h', '* * * * *', $$select public.coin_stats_24h()$$);

-- ascend_token_stats: a plain view on coin_stats again (same columns as before)
drop materialized view public.ascend_token_stats;
drop view public.ascend_token_stats_live;
create view public.ascend_token_stats with (security_invoker = true) as
 SELECT a.address,
    COALESCE(k.handle, lower(a.symbol)) AS handle,
    COALESCE(k.symbol, a.symbol) AS symbol,
    k.category,
    COALESCE(k.creator, ''::text) AS creator,
    k.x_user_id,
    COALESCE(u.x_name, CASE WHEN k.address IS NULL THEN a.name ELSE NULL::text END) AS x_name,
    COALESCE(u.x_pfp_url, k.pfp_url, CASE WHEN a.image_cid IS NOT NULL THEN 'https://gateway.pinata.cloud/ipfs/'::text || a.image_cid ELSE NULL::text END) AS x_pfp_url,
    a.launched_at,
    true AS graduated,
    a.pool_id AS pair,
    a.launched_at AS graduated_at,
    g.price_hype,
    g.price_hype * a.supply AS mcap_hype,
    COALESCE(g.price_hype_24h_ago, g.price_hype) AS price_hype_24h_ago,
    1 AS curve_progress,
    COALESCE(g.trades, 0::bigint) AS trades,
    COALESCE(g.trades_24h, 0::bigint) AS trades_24h,
    COALESCE(g.volume_usd, 0::numeric) AS volume_usd,
    COALESCE(g.volume_usd_24h, 0::numeric) AS volume_usd_24h,
    COALESCE(g.volume_hype, 0::numeric) AS volume_hype,
    g.last_trade_at,
    COALESCE(k.kind, 'individual'::text) AS kind,
    k.name,
    k.member_x_user_ids,
    NULL::text AS sector,
    k.launchpad,
    k.address IS NOT NULL AS ours,
    a.name AS token_name,
    a.quote_symbol,
    a.quote
   FROM ascend_tokens a
     LEFT JOIN tokens k ON k.address = a.address AND NOT k.registry IS DISTINCT FROM (SELECT app_config.value FROM app_config WHERE app_config.key = 'registry'::text)
     LEFT JOIN user_cards u ON u.x_user_id = k.x_user_id
     LEFT JOIN coin_stats g ON g.market = a.address;
grant select on public.ascend_token_stats to anon, authenticated, service_role;

-- token_stats: same columns, reading coin_stats
create or replace view public.token_stats with (security_invoker = true) as
 SELECT k.address,
    k.handle,
    k.symbol,
    k.category,
    k.creator,
    k.x_user_id,
    u.x_name,
    COALESCE(u.x_pfp_url, k.pfp_url) AS x_pfp_url,
    k.launched_at,
    k.graduated,
    k.pair,
    k.graduated_at,
    COALESCE(g.price_hype, k.virtual_hype / 1073000000::numeric) AS price_hype,
    COALESCE(g.price_hype, k.virtual_hype / 1073000000::numeric) * 1000000000::numeric AS mcap_hype,
    COALESCE(g.price_hype_24h_ago, k.virtual_hype / 1073000000::numeric) AS price_hype_24h_ago,
        CASE
            WHEN k.graduated THEN 1::numeric
            ELSE LEAST(COALESCE(g.curve_sold, 0::numeric) / 793100000::numeric, 1::numeric)
        END AS curve_progress,
    COALESCE(g.trades, 0::bigint) AS trades,
    COALESCE(g.trades_24h, 0::bigint) AS trades_24h,
    COALESCE(g.volume_usd, 0::numeric) AS volume_usd,
    COALESCE(g.volume_usd_24h, 0::numeric) AS volume_usd_24h,
    COALESCE(g.volume_hype, 0::numeric) AS volume_hype,
    g.last_trade_at,
    k.kind,
    k.name,
    k.member_x_user_ids,
    ( SELECT cp.content::jsonb ->> 'sector'::text
           FROM creator_profiles cp
          WHERE cp.hash = k.profile_hash) AS sector,
    k.launchpad
   FROM tokens k
     LEFT JOIN user_cards u USING (x_user_id)
     LEFT JOIN coin_stats g ON g.market = k.address
  WHERE NOT k.registry IS DISTINCT FROM app_registry();

notify pgrst, 'reload schema';

commit;
