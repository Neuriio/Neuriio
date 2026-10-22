-- Rate limits for the Edge Functions (security review 2026-10-22), kept in the database so they hold across every
-- function instance and restart (the old in-memory counters reset on each cold start).
-- hit_rate_limit(key, limit, window_s): records one hit for `key` and returns true, or returns false (no hit
-- recorded) when `key` already has `limit` hits in the last `window_s` seconds. Hits for one key are serialized by an
-- advisory lock, so parallel requests can't slip past the limit. Server-only: the functions' secret key.
create table public.rate_limit_hits (
  key text not null,
  at timestamptz not null default now()
);
create index rate_limit_hits_key_at on public.rate_limit_hits (key, at desc);
alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from anon, authenticated;

create function public.hit_rate_limit(p_key text, p_limit integer, p_window_s integer)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('rate:' || p_key, 0));
  select count(*) into n
    from public.rate_limit_hits
   where key = p_key and at > now() - make_interval(secs => p_window_s);
  if n >= p_limit then
    return false;
  end if;
  insert into public.rate_limit_hits (key) values (p_key);
  return true;
end;
$$;
revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;

-- hits older than the longest window (an hour) are useless: clear them every 10 minutes
select cron.schedule('neuriio-rate-limit-cleanup', '*/10 * * * *',
  $$ delete from public.rate_limit_hits where at < now() - interval '1 hour' $$);
