-- Neuriio (user, 2026-11-01): stakers are the only ones who get it, 100 for every $1 of fees they earn. A tally that converts into the
-- token when it launches. keeper/src/fees/neuriio.mjs works it out from the staking contract's events and saves it here.

-- Everyone's Neuriio, per token they staked, in millionths. Public: it comes from public on-chain events.
create table public.neuriio_balances (
  wallet text not null,   -- lower case
  token text not null,    -- lower case
  minted numeric not null,
  updated_at timestamptz not null default now(),
  primary key (wallet, token)
);
alter table public.neuriio_balances enable row level security;
create policy "neuriio balances are public" on public.neuriio_balances for select to anon, authenticated using (true);
grant select on public.neuriio_balances to anon, authenticated;

-- How far the tally has read, and its working numbers: one row. Private.
create table public.neuriio_tally (
  id boolean primary key default true check (id),
  next_block bigint not null,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.neuriio_tally enable row level security;
revoke all on public.neuriio_tally from anon, authenticated;

create or replace function public.neuriio_save(p_next_block bigint, p_state jsonb, p_balances jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into neuriio_tally (id, next_block, state) values (true, p_next_block, p_state)
    on conflict (id) do update set next_block = excluded.next_block, state = excluded.state, updated_at = now();
  insert into neuriio_balances (wallet, token, minted)
    select b.wallet, b.token, b.minted from jsonb_to_recordset(p_balances) as b(wallet text, token text, minted numeric)
    on conflict (wallet, token) do update set minted = excluded.minted, updated_at = now();
end $$;
revoke all on function public.neuriio_save(bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.neuriio_save(bigint, jsonb, jsonb) to service_role;
