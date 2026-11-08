-- NOT APPLIED. Vamp watch (user, 2026-11-05): a coin launched outside Neuriio that has reached a $75k market cap keeps its ticker's
-- first 4 characters, the same way a Neuriio launch does, so nobody can launch a ticker sharing them through Neuriio (a fresh X account
-- named after a coin that's running elsewhere). Coins that never got there don't count: the same ticker can launch 100 times elsewhere
-- and most of them never trade, so blocking all of them would refuse real people whose handle happens to match a dead coin. Once a coin
-- reaches the bar it counts for good, even if its price falls back.
--
-- For now this covers Ascend's coins (ascend_tokens, filled by the indexer's "ascend_all" world). Their market cap is the pool price
-- after each trade times the supply, in USD, the same as ascend_token_stats. The bar is app_config 'vamp_watch_mcap_usd' (edit it in the
-- table editor; no redeploy). The other Elysium launchpads (BOXA, ElysPump, Kleos, ...) aren't indexed yet.

insert into public.app_config (key, value) values ('vamp_watch_mcap_usd', '75000') on conflict (key) do nothing;

alter table public.ascend_tokens add column peak_mcap_usd numeric; -- the highest market cap after any of its trades; null: none priced yet
create index ascend_tokens_prefix on public.ascend_tokens (public.ticker_prefix(symbol));

-- Every insert into trades raises the peak of the Ascend coins it traded (one update per insert, whatever its size).
create function public.ascend_tokens_peak() returns trigger
language plpgsql set search_path = public as $$
begin
  update ascend_tokens a
     set peak_mcap_usd = m.top * a.supply
    from (select market, max(price_hype) as top from new_trades
           where venue = 'pool' and price_hype is not null group by market) m
   where a.address = m.market
     and (a.peak_mcap_usd is null or m.top * a.supply > a.peak_mcap_usd);
  return null;
end $$;
create trigger trades_ascend_peak after insert on public.trades
  referencing new table as new_trades for each statement execute function public.ascend_tokens_peak();

-- the coins indexed before this
update public.ascend_tokens a set peak_mcap_usd = t.top * a.supply
  from (select market, max(price_hype) as top from public.trades
         where venue = 'pool' and price_hype is not null group by market) t
 where t.market = a.address;

-- claim_launch from 20261101195140_launch_claims.sql, with one more ticker check: after Neuriio's own launches, the coins above.
-- Its answer then says where that coin launched: {"conflict": "ticker", "with": <ticker>, "launchpad": "Ascend"}.
create or replace function public.claim_launch(
  p_ticker text, p_owners text[], p_grid text[], p_mirror text, p_thumb text, p_max_bits integer, p_deadline timestamptz, p_commit boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t text := upper(p_ticker);
  p text := public.ticker_prefix(p_ticker);
  reg text := (select lower(value) from app_config where key = 'registry');
  bar numeric := coalesce((select value::numeric from app_config where key = 'vamp_watch_mcap_usd'), 75000);
  grid bit(144)[] := p_grid::bit(144)[];
  taken text;
  suspects jsonb := '[]'::jsonb;
  mine bigint;
begin
  perform pg_advisory_xact_lock(hashtext('launch_claims'));

  select k.symbol into taken from tokens k
    where public.ticker_prefix(k.symbol) = p and lower(k.registry) = reg limit 1;
  if taken is null and p <> '' then
    select upper(a.symbol) into taken from ascend_tokens a
      where public.ticker_prefix(a.symbol) = p and a.peak_mcap_usd >= bar
      order by a.peak_mcap_usd desc limit 1;
    if taken is not null then
      return jsonb_build_object('conflict', 'ticker', 'with', taken, 'launchpad', 'Ascend');
    end if;
  end if;
  if taken is null then
    select c.ticker into taken from launch_claims c
      where c.prefix = p and c.deadline > now() and not (c.ticker = t and c.owners && p_owners) limit 1;
  end if;
  if taken is not null then
    return jsonb_build_object('conflict', 'ticker', 'with', taken);
  end if;

  if grid is not null then
    select coalesce(jsonb_agg(jsonb_build_object('ticker', s.ticker, 'thumb', encode(s.pfp_thumb, 'base64'), 'hits', s.hits) order by s.best), '[]'::jsonb)
      into suspects
      from (
        select c.ticker, c.pfp_thumb, h.best, h.hits
          from launch_claims c
          cross join lateral (
            select min(x.d) as best, jsonb_agg(jsonb_build_object('w', x.w, 'kind', x.kind) order by x.d) as hits
              from (
                -- at most 5 windows per direction: the closest are the ones worth confirming
                (select i::int as w, least(bit_count(v # grid[1]), bit_count(v # p_mirror::bit(144))) as d,
                        case when bit_count(v # grid[1]) <= bit_count(v # p_mirror::bit(144)) then 'crop' else 'mirror' end as kind
                   from unnest(c.pfp_grid) with ordinality g(v, i)
                  where least(bit_count(v # grid[1]), bit_count(v # p_mirror::bit(144))) <= p_max_bits
                  order by 2 limit 5)
                union all
                (select i::int, bit_count(v # c.pfp_grid[1]), 'border'
                   from unnest(grid) with ordinality g(v, i)
                  where bit_count(v # c.pfp_grid[1]) <= p_max_bits
                  order by 2 limit 5)
              ) x
          ) h
         where c.pfp_grid is not null
           and h.hits is not null
           and not (c.owners && p_owners)
           and (c.deadline > now() or exists (select 1 from tokens k where k.symbol = c.ticker and lower(k.registry) = reg))
         order by h.best
         limit 200
      ) s;
  end if;

  if p_commit then
    delete from launch_claims c where c.ticker = t and c.owners && p_owners; -- a retry replaces its own earlier claim
    insert into launch_claims (ticker, owners, pfp_grid, pfp_thumb, deadline)
      values (t, p_owners, grid, decode(p_thumb, 'base64'), p_deadline)
      returning id into mine;
  end if;
  return jsonb_build_object('conflict', null, 'claim', mine, 'suspects', suspects);
end $$;
revoke all on function public.claim_launch(text, text[], text[], text, text, integer, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.claim_launch(text, text[], text[], text, text, integer, timestamptz, boolean) to service_role;
