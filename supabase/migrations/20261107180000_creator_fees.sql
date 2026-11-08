-- Creator fees per token (user, 2026-11-07): what each token's creator has earned on Ascend, for our launches AND Ascend's top
-- tokens shown on Explore. Filled by the indexer every 5 minutes from each token's CreatorEscrow on Ascend:
--   credited = the sum of the escrow's Credited events (each settle credits the creator's share, then pays it out), lifetime
--   held     = the escrow's held(): creator fees held back while the token is under Ascend's $40k qualifying market cap
--   total_fees = the escrow's cumulativeFees(): every fee the pool has taken (the whole 1%), lifetime
-- Amounts are in the pair's base units (USDC: 6 decimals, WHYPE: 18). earned_usd is (credited + held) in USD at the last run.
-- Visitors read this table instead of the chain: no RPC calls per visitor.
create table public.creator_fees (
  token          text primary key,           -- lower case
  pool_id        text not null,
  escrow         text not null,              -- lower case
  quote          text not null,              -- the pair asset, lower case
  quote_decimals integer not null,
  recipient      text,
  credited       numeric not null default 0,
  held           numeric not null default 0,
  total_fees     numeric not null default 0,
  earned_usd     numeric not null default 0,
  scanned_to     bigint not null,            -- last block whose Credited events are counted
  updated_at     timestamptz not null default now()
);
create index creator_fees_scanned on public.creator_fees (scanned_to);
alter table public.creator_fees enable row level security;
create policy "creator fees are public" on public.creator_fees for select to anon, authenticated using (true);
grant select on public.creator_fees to anon, authenticated;
grant select, insert, update on public.creator_fees to service_role;
