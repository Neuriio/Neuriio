-- APPLIED 2026-11-05.
-- Ban list (user, 2026-11-05): tickers nobody can launch through Neuriio, even when their X handle matches. Edit it in Supabase's
-- table editor: add a row with the ticker (any case, with or without "$"; it's stored upper-case) and, optionally, why.
-- The launch-pass and ftf functions refuse to sign a pass for a banned ticker, so the launch can't happen. Private: only those
-- functions (service role) read it.
create table public.banned_tickers (
  ticker     text primary key,
  reason     text,
  created_at timestamptz not null default now()
);

create function public.banned_tickers_normalize() returns trigger
language plpgsql set search_path = public as $$
begin
  new.ticker := upper(regexp_replace(trim(new.ticker), '^\$', ''));
  if new.ticker !~ '^[A-Z0-9_]{1,15}$' then
    raise exception 'banned ticker must be 1-15 letters, digits or _ (got %)', new.ticker;
  end if;
  return new;
end $$;
create trigger banned_tickers_normalize before insert or update on public.banned_tickers
  for each row execute function public.banned_tickers_normalize();

alter table public.banned_tickers enable row level security;
revoke all on public.banned_tickers from anon, authenticated;
grant select on public.banned_tickers to service_role;
