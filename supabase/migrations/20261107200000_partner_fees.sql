-- Partner fees (keeper/src/fees/partner.mjs, user 2026-11-07): our 0.5% on trades of OUTSIDE tokens through NeuriioSwap.
-- The fee arrives in the pool's quote (mostly HYPE); stakers are paid in USDC from a float the fee wallet keeps, valued at the
-- Hyperliquid price when the fee was recorded. The HYPE itself stays in the wallet. Same shape as the fee router's tables
-- (20261101181131_fee_router.sql) plus what the fee was in and its price. Service role only: no policies.
-- `amount` = the fee's USDC value (base units, text). A fee with no USDC value (a quote we can't price) has amount '0' and
-- reason 'unpriced_quote': held, never paid, until someone prices it by hand.
create table public.partner_fee_runs (
  id bigint generated always as identity primary key,
  status text not null default 'open' check (status in ('open', 'halted', 'done')),
  total text not null,
  note text,
  created_at timestamptz not null default now()
);
create unique index partner_fee_runs_one_unfinished on public.partner_fee_runs ((true)) where status <> 'done';

create table public.partner_fee_receipts (
  tx_hash text not null,
  log_index integer not null,
  block_number text not null,
  from_address text not null, -- the NeuriioSwap that emitted it
  amount text not null, -- USDC value, base units
  token text, -- null = held (unpriced)
  pool text,
  reason text,
  quote text not null, -- what the fee was paid in (0x0 = native HYPE)
  fee_raw text not null, -- the fee in the quote's base units
  price_usd text, -- quote price used (USD per whole unit)
  run_id bigint references public.partner_fee_runs (id),
  created_at timestamptz not null default now(),
  primary key (tx_hash, log_index)
);
create index partner_fee_receipts_unpaid on public.partner_fee_receipts (token) where run_id is null;

create table public.partner_fee_run_items (
  id bigint generated always as identity primary key,
  run_id bigint not null references public.partner_fee_runs (id),
  seq integer not null,
  kind text not null check (kind in ('approve', 'reward', 'treasury')),
  token text,
  amount text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'rerouted', 'failed')),
  tx_hash text,
  raw_tx text,
  unique (run_id, seq)
);

alter table public.partner_fee_runs enable row level security;
alter table public.partner_fee_receipts enable row level security;
alter table public.partner_fee_run_items enable row level security;
revoke all on public.partner_fee_runs, public.partner_fee_receipts, public.partner_fee_run_items from anon, authenticated;

create or replace function public.partner_fee_create_run(p_total text, p_receipts jsonb, p_items jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  rid bigint;
  claimed integer;
begin
  insert into partner_fee_runs (total) values (p_total) returning id into rid;
  update partner_fee_receipts r set run_id = rid
    from jsonb_to_recordset(p_receipts) as x(tx_hash text, log_index integer)
    where r.tx_hash = x.tx_hash and r.log_index = x.log_index and r.run_id is null;
  get diagnostics claimed = row_count;
  if claimed <> jsonb_array_length(p_receipts) then
    raise exception 'partner_fee_create_run: % of % fees were still unpaid', claimed, jsonb_array_length(p_receipts);
  end if;
  insert into partner_fee_run_items (run_id, seq, kind, token, amount)
    select rid, (x.ord - 1)::integer, x.kind, x.token, x.amount
    from rows from (jsonb_to_recordset(p_items) as (kind text, token text, amount text)) with ordinality as x(kind, token, amount, ord);
  return rid;
end $$;
revoke all on function public.partner_fee_create_run(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.partner_fee_create_run(text, jsonb, jsonb) to service_role;
