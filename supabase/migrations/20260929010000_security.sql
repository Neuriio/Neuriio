-- Security review 2026-09-29.
--
-- 1. rebuild_candle() is SECURITY DEFINER and Postgres grants EXECUTE on new functions to PUBLIC, so anyone with the
--    public key could call it (verified: HTTP 204 as anon) and write a candle at a misaligned bucket time, which
--    shifts token_chart's series off the real candles (a corrupted chart). Only the trades trigger should run it.
--    Also reject misaligned buckets inside it (defense in depth).
revoke all on function public.rebuild_candle(text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.trades_to_candles() from public, anon, authenticated;

create or replace function public.rebuild_candle(p_token text, p_interval integer, p_bucket timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare
  prev numeric;
begin
  if p_bucket <> candle_bucket(p_bucket, p_interval) then
    raise exception 'bucket % is not aligned to % s', p_bucket, p_interval;
  end if;
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
revoke all on function public.rebuild_candle(text, integer, timestamptz) from public, anon, authenticated;

-- 2. Privacy: don't publish which wallet belongs to which X account. Launchers are linked on-chain anyway (the
--    Launched event carries both), but ordinary traders shouldn't be. Three public places linked them:
--      user_cards.wallet, trades.x_user_id, and points_ledger.ref (= a trade id -> that trade's wallet).
--    Column-level grants hide just those columns; everything the app and the views read stays public.
revoke select on public.user_cards from anon, authenticated;
grant select (x_user_id, x_handle, x_name, x_pfp_url, created_at) on public.user_cards to anon, authenticated;

revoke select on public.trades from anon, authenticated;
grant select (id, venue, trader, market, side, size, quote_amount, usd_value, fee, tx_hash, log_index, hl_tid,
              block_number, ts, price_hype, curve_sold) on public.trades to anon, authenticated;

revoke select on public.points_ledger from anon, authenticated;
grant select (id, x_user_id, points, reason, created_at) on public.points_ledger to anon, authenticated;
