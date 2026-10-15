-- Testnet HYPE faucet: one automatic 0.2 HYPE per X account, ever, sent by the `ftf` Edge Function (action claimHype)
-- from a dedicated faucet wallet (secret FAUCET_KEY; not the deployer/owner key). The row is inserted BEFORE sending, so
-- the primary key is the "once per X account" lock; a failed send deletes it again. When the faucet can't pay (no key,
-- low balance), the app falls back to the manual request (hype_requests). Service role only: no policies.

create table public.hype_claims (
  x_user_id text primary key references public.users (x_user_id),
  wallet text not null,
  amount numeric not null,
  status text not null default 'sending' check (status in ('sending', 'sent')),
  tx_hash text,
  created_at timestamptz not null default now()
);
create index hype_claims_wallet on public.hype_claims (wallet);
alter table public.hype_claims enable row level security;
