-- Security sweep 2026-09-29: an open FTF draft holds its ticker (one open draft per ticker), so without an expiry
-- anyone could park up to 3 tickers forever. Drafts with no activity for 7 days are cancelled daily (frees the ticker).
create or replace function public.expire_ftf_drafts() returns integer
language sql security definer set search_path = public as $$
  with gone as (
    update ftf_drafts set status = 'cancelled', updated_at = now()
     where status = 'open' and updated_at < now() - interval '7 days'
    returning 1
  )
  select count(*)::integer from gone;
$$;
revoke all on function public.expire_ftf_drafts() from public, anon, authenticated;
select cron.schedule('neuriio-ftf-expiry', '17 3 * * *', $$ select public.expire_ftf_drafts() $$);
