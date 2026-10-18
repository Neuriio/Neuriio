-- Test USDC faucet (2026-10-18): one 1,000 test USDC per X account, ever, sent by the `ftf` Edge Function (claimHype,
-- together with the 0.2 HYPE) from the faucet wallet's own USDC balance (funded by the owner: 500k to start). Same
-- lock as hype_claims: the row is inserted BEFORE sending, so the primary key is the "once per X account" lock; a
-- failed send deletes it again. Service role only: no policies.

create table public.usdc_claims (
  x_user_id text primary key references public.users (x_user_id),
  wallet text not null,
  amount numeric not null,
  status text not null default 'sending' check (status in ('sending', 'sent')),
  tx_hash text,
  created_at timestamptz not null default now()
);
create index usdc_claims_wallet on public.usdc_claims (wallet);
alter table public.usdc_claims enable row level security;
