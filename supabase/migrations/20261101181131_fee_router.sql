-- The fee router's records (keeper/src/fees): every fee that reached the fee wallet, and every payout run and transaction.
-- Service role only: no policies. Amounts are USDC base units as text, so nothing rounds. A fee with no token is unmatched:
-- it stays in the wallet until someone sets its token by hand, and the next run then pays it.
create table public.fee_runs (
  id bigint generated always as identity primary key,
  status text not null default 'open' check (status in ('open', 'halted', 'done')),
  total text not null,
  note text,
  created_at timestamptz not null default now()
);
-- Only one unfinished run at a time.
create unique index fee_runs_one_unfinished on public.fee_runs ((true)) where status <> 'done';

create table public.fee_receipts (
  tx_hash text not null,
  log_index integer not null,
  block_number text not null,
  from_address text not null,
  amount text not null,
  token text,
  pool text,
  reason text,
  run_id bigint references public.fee_runs (id),
  created_at timestamptz not null default now(),
  primary key (tx_hash, log_index)
);
create index fee_receipts_unpaid on public.fee_receipts (token) where run_id is null;

-- raw_tx is saved before sending, so a crash resends the same transaction instead of signing a second one.
create table public.fee_run_items (
  id bigint generated always as identity primary key,
  run_id bigint not null references public.fee_runs (id),
  seq integer not null,
  kind text not null check (kind in ('approve', 'reward', 'treasury')),
  token text,
  amount text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'rerouted', 'failed')),
  tx_hash text,
  raw_tx text,
  unique (run_id, seq)
);

alter table public.fee_runs enable row level security;
alter table public.fee_receipts enable row level security;
alter table public.fee_run_items enable row level security;
revoke all on public.fee_runs, public.fee_receipts, public.fee_run_items from anon, authenticated;

-- Creates a run and claims its fees in one step. Fails if any fee was already claimed.
create or replace function public.fee_create_run(p_total text, p_receipts jsonb, p_items jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  rid bigint;
  claimed integer;
begin
  insert into fee_runs (total) values (p_total) returning id into rid;
  update fee_receipts r set run_id = rid
    from jsonb_to_recordset(p_receipts) as x(tx_hash text, log_index integer)
    where r.tx_hash = x.tx_hash and r.log_index = x.log_index and r.run_id is null;
  get diagnostics claimed = row_count;
  if claimed <> jsonb_array_length(p_receipts) then
    raise exception 'fee_create_run: % of % fees were still unpaid', claimed, jsonb_array_length(p_receipts);
  end if;
  insert into fee_run_items (run_id, seq, kind, token, amount)
    select rid, (ord - 1)::integer, x.kind, x.token, x.amount
    from jsonb_to_recordset(p_items) with ordinality as x(kind text, token text, amount text, ord bigint);
  return rid;
end $$;
revoke all on function public.fee_create_run(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.fee_create_run(text, jsonb, jsonb) to service_role;
