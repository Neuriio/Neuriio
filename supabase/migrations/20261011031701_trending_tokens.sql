-- /trending's "Trending" column: tokens ranked by USD volume over the last p_days days (curve + pool trades),
-- returned as token_stats rows so the app reads them like every other list. Read-only, runs as the caller.
create or replace function public.trending_tokens(p_days integer default 3, p_limit integer default 25)
returns setof public.token_stats
language sql stable security invoker set search_path = public as $$
  select s.*
    from public.token_stats s
    join (
      select market, sum(usd_value) as v
        from public.trades
       where venue in ('curve', 'pool')
         and usd_value is not null
         and ts > now() - make_interval(days => least(greatest(p_days, 1), 30))
       group by market
    ) w on w.market = s.address
   order by w.v desc nulls last
   limit least(greatest(p_limit, 1), 100);
$$;
grant execute on function public.trending_tokens(integer, integer) to anon, authenticated;
