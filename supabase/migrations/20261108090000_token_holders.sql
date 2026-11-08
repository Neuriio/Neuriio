-- Top holders (user, 2026-11-08: replaces the Launch check widget; the Launch check service, table and code stay). Every holder's
-- balance per coin, kept by the launch-check service (keeper/src/holders/holders.mjs) from the coin's own Transfer events: our own
-- chain data, no explorer. The app reads the top 10 straight from token_balances (index token_balances_top).
--   token_balances  (token, holder) -> balance in base units; rows that reach 0 are removed
--   holder_scans    token -> the last block whose transfers are counted
--   holders_apply() adds one block range's balance changes AND moves the cursor in one transaction, and only if the range starts
--                   right after the cursor: a retry or a restart can never count a transfer twice.

create table public.token_balances (
  token text not null,
  holder text not null,
  balance numeric not null,
  primary key (token, holder)
);
create index token_balances_top on public.token_balances (token, balance desc);
alter table public.token_balances enable row level security;
create policy token_balances_read on public.token_balances for select to anon, authenticated using (true);
grant select on public.token_balances to anon, authenticated;
grant all on public.token_balances to service_role;

create table public.holder_scans (
  token text primary key,
  scanned_to bigint not null,
  updated_at timestamptz not null default now()
);
alter table public.holder_scans enable row level security;
grant all on public.holder_scans to service_role;

-- p_deltas: [{"holder": "0x…", "delta": "-123"}, …] (base units as text). True = applied; false = this range isn't next (skipped).
create or replace function public.holders_apply(p_token text, p_from bigint, p_to bigint, p_deltas jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  cur bigint;
begin
  perform pg_advisory_xact_lock(hashtext('holders:' || p_token));
  select scanned_to into cur from holder_scans where token = p_token;
  if (cur is null and exists (select 1 from token_balances where token = p_token)) or (cur is not null and p_from <> cur + 1) then
    return false;
  end if;
  insert into token_balances as b (token, holder, balance)
    select p_token, lower(x.holder), sum(x.delta::numeric) from jsonb_to_recordset(p_deltas) as x(holder text, delta text) group by lower(x.holder)
  on conflict (token, holder) do update set balance = b.balance + excluded.balance;
  delete from token_balances where token = p_token and balance = 0;
  insert into holder_scans (token, scanned_to, updated_at) values (p_token, p_to, now())
  on conflict (token) do update set scanned_to = excluded.scanned_to, updated_at = now();
  return true;
end $$;
revoke all on function public.holders_apply(text, bigint, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.holders_apply(text, bigint, bigint, jsonb) to service_role;
