-- Stored price candles (5m, 15m, 30m, 1h, 4h) for launched tokens, so charts load instantly and stay correct after old
-- raw trades are archived. A statement-level trigger on `trades` rebuilds every bucket an insert touches (the indexer
-- inserts each block range in one statement, in chain order, so later buckets never need fixing up afterwards).
-- A trade's price is the spot price AFTER it; a candle opens at the previous trade's price (the previous close).

create table public.candles (
  token        text not null,                      -- token address (lowercase)
  interval_s   integer not null check (interval_s in (300, 900, 1800, 3600, 14400)),
  bucket       timestamptz not null,               -- bucket start
  open         numeric not null,                   -- HYPE per token
  high         numeric not null,
  low          numeric not null,
  close        numeric not null,
  volume_hype  numeric not null default 0,
  volume_usd   numeric not null default 0,
  trades       integer not null default 0,
  primary key (token, interval_s, bucket)
);
alter table public.candles enable row level security;
create policy "candles are public" on public.candles for select using (true);

create or replace function public.candle_bucket(p_ts timestamptz, p_seconds integer) returns timestamptz
language sql immutable as $$
  select to_timestamp(floor(extract(epoch from p_ts) / p_seconds) * p_seconds)
$$;

-- Recomputes one candle from the raw trades in its bucket.
create or replace function public.rebuild_candle(p_token text, p_interval integer, p_bucket timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare
  prev numeric;
begin
  -- previous close = the last earlier candle of this interval (no trades lie between it and this bucket, or they
  -- would have their own candle). Read from candles, not trades, so it still works after old trades are archived.
  select c.close into prev from candles c
   where c.token = p_token and c.interval_s = p_interval and c.bucket < p_bucket
   order by c.bucket desc
   limit 1;
  if prev is null then
    select k.virtual_hype / 1073000000 into prev from tokens k where k.address = p_token; -- opening price
  end if;

  insert into candles as c (token, interval_s, bucket, open, high, low, close, volume_hype, volume_usd, trades)
  select p_token, p_interval, p_bucket,
         coalesce(prev, (array_agg(x.price_hype order by x.ts, x.block_number, x.log_index))[1]),
         greatest(max(x.price_hype), coalesce(prev, max(x.price_hype))),
         least(min(x.price_hype), coalesce(prev, min(x.price_hype))),
         (array_agg(x.price_hype order by x.ts desc, x.block_number desc, x.log_index desc))[1],
         coalesce(sum(x.quote_amount), 0), coalesce(sum(x.usd_value), 0), count(*)
    from trades x
   where x.market = p_token and x.venue in ('curve', 'pool') and x.price_hype is not null
     and x.ts >= p_bucket and x.ts < p_bucket + make_interval(secs => p_interval)
  having count(*) > 0
  on conflict (token, interval_s, bucket) do update
    set open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
        volume_hype = excluded.volume_hype, volume_usd = excluded.volume_usd, trades = excluded.trades;
end $$;

create or replace function public.trades_to_candles() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  for r in
    select distinct n.market, i.s, candle_bucket(n.ts, i.s) as b
      from new_rows n cross join unnest(array[300, 900, 1800, 3600, 14400]) as i(s)
     where n.venue in ('curve', 'pool') and n.price_hype is not null
     order by 3, 1, 2
  loop
    perform rebuild_candle(r.market, r.s, r.b);
  end loop;
  return null;
end $$;

create trigger trades_to_candles after insert on public.trades
  referencing new table as new_rows
  for each statement execute function public.trades_to_candles();

-- Chart data: the last `p_limit` buckets (max 1000) up to now, with no gaps: a bucket without trades is a flat candle
-- at the last close. Starts at the token's first candle if that's later. Empty until the token's first trade.
create or replace function public.token_chart(p_token text, p_interval integer default 900, p_limit integer default 300)
returns table (bucket timestamptz, open numeric, high numeric, low numeric, close numeric,
               volume_hype numeric, volume_usd numeric, trades integer)
language sql stable security invoker set search_path = public as $$
  with cfg as (
    select lower(p_token) as tok, p_interval as s, least(greatest(p_limit, 1), 1000) as n,
           candle_bucket(now(), p_interval) as end_b
  ),
  rng as (
    select cfg.*,
           greatest((select min(c.bucket) from candles c where c.token = cfg.tok and c.interval_s = cfg.s),
                    cfg.end_b - make_interval(secs => cfg.s * (cfg.n - 1))) as start_b
      from cfg
  ),
  seed as (
    select c.close from candles c, rng
     where c.token = rng.tok and c.interval_s = rng.s and c.bucket < rng.start_b
     order by c.bucket desc limit 1
  ),
  joined as (
    select g.b, c.open, c.high, c.low, c.close, c.volume_hype, c.volume_usd, c.trades,
           count(c.close) over (order by g.b) as grp
      from rng
     cross join generate_series(rng.start_b, rng.end_b, make_interval(secs => rng.s)) as g(b)
      left join candles c on c.token = rng.tok and c.interval_s = rng.s and c.bucket = g.b
  ),
  filled as (
    select j.*, coalesce(first_value(j.close) over (partition by j.grp order by j.b), (select close from seed)) as carry
      from joined j
  )
  select f.b, coalesce(f.open, f.carry), coalesce(f.high, f.carry), coalesce(f.low, f.carry), coalesce(f.close, f.carry),
         coalesce(f.volume_hype, 0), coalesce(f.volume_usd, 0), coalesce(f.trades, 0)
    from filled f
   where f.carry is not null or f.close is not null
   order by f.b;
$$;
grant execute on function public.token_chart(text, integer, integer) to anon, authenticated;

-- Superseded by the stored candles.
drop function if exists public.token_candles(text, integer, timestamptz);

-- Backfill (the trades table was empty when this shipped; kept for safety).
do $$
declare r record;
begin
  for r in
    select distinct x.market, i.s, candle_bucket(x.ts, i.s) as b
      from trades x cross join unnest(array[300, 900, 1800, 3600, 14400]) as i(s)
     where x.venue in ('curve', 'pool') and x.price_hype is not null
     order by 3, 1, 2
  loop
    perform rebuild_candle(r.market, r.s, r.b);
  end loop;
end $$;
