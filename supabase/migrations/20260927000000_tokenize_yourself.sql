-- "Tokenize Yourself": users (X login via Privy), their one token + thesis, trading activity, points.
-- Writes happen only server-side (Edge Functions / indexer with the service role, which bypasses RLS).
-- The browser reads with the anon key: public tables below have read-only policies; `users` is private.

-- ------------------------------------------------------------------ people

create table public.users (
  privy_id      text primary key,                 -- did:privy:...
  x_user_id     text not null unique,             -- permanent X user ID (numeric string)
  x_handle      text not null,                    -- current handle, without "@"
  x_name        text,
  x_pfp_url     text,
  wallet        text not null unique,             -- Privy embedded "Neuriio wallet", lowercase 0x...
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
alter table public.users enable row level security; -- no public policies: privy_id stays private

-- Public profile card (no Privy id)
create view public.profiles with (security_invoker = false) as
  select x_user_id, x_handle, x_name, x_pfp_url, wallet, created_at from public.users;
grant select on public.profiles to anon, authenticated;

-- ------------------------------------------------------------------ theses + tokens

-- A thesis is fixed forever once its hash is on-chain. `content` is the exact JSON string that was hashed:
-- keccak256(utf8(content)) = hash.
create table public.theses (
  hash        text primary key,                    -- 0x... keccak256 of content
  x_user_id   text not null references public.users (x_user_id),
  content     text not null,
  body        jsonb generated always as (content::jsonb) stored,
  created_at  timestamptz not null default now()
);
alter table public.theses enable row level security;
create policy "theses are public" on public.theses for select using (true);

create type public.creator_category as enum ('trader', 'meme_trader', 'researcher', 'influencer', 'builder', 'creator');

-- Filled from the Launchpad's Launched / Graduated events.
create table public.tokens (
  address       text primary key,                  -- lowercase
  x_user_id     text not null unique,
  creator       text not null,                     -- wallet
  handle        text not null,                     -- as launched (name = "@" || handle)
  symbol        text not null,
  category      public.creator_category not null,
  thesis_hash   text not null references public.theses (hash),
  launch_tx     text not null,
  launch_block  bigint not null,
  launched_at   timestamptz not null,
  graduated     boolean not null default false,
  pair          text,
  graduated_at  timestamptz
);
alter table public.tokens enable row level security;
create policy "tokens are public" on public.tokens for select using (true);

-- Launch passes we signed (audit trail; a pass is single-use on-chain anyway).
create table public.launch_passes (
  id           bigint generated always as identity primary key,
  privy_id     text not null references public.users (privy_id),
  x_user_id    text not null,
  wallet       text not null,
  handle       text not null,
  category     public.creator_category not null,
  thesis_hash  text not null references public.theses (hash),
  deadline     timestamptz not null,
  signature    text not null,
  created_at   timestamptz not null default now()
);
alter table public.launch_passes enable row level security; -- private

-- ------------------------------------------------------------------ activity

create type public.venue as enum ('curve', 'pool', 'hl_perp', 'hl_spot', 'hl_outcome');

-- One row per trade: launchpad curve + graduated pools (Elysium events) and Hyperliquid fills
-- (orders placed through our app, attributed by our builder code).
create table public.trades (
  id            bigint generated always as identity primary key,
  venue         public.venue not null,
  trader        text not null,                     -- wallet (lowercase)
  x_user_id     text,                              -- filled when the wallet belongs to a user
  market        text not null,                     -- token address (curve/pool) or HL coin
  side          text not null check (side in ('buy', 'sell')),
  size          numeric not null,                  -- tokens / contracts
  quote_amount  numeric not null,                  -- HYPE (curve/pool) or USDC (HL)
  usd_value     numeric,
  fee           numeric,
  tx_hash       text,                              -- Elysium tx (curve/pool)
  log_index     integer,
  hl_tid        bigint,                            -- Hyperliquid trade id
  block_number  bigint,
  ts            timestamptz not null,
  unique (tx_hash, log_index),
  unique (hl_tid)
);
create index trades_trader_ts on public.trades (trader, ts desc);
create index trades_market_ts on public.trades (market, ts desc);
create index trades_x_user on public.trades (x_user_id, ts desc);
alter table public.trades enable row level security;
create policy "trades are public" on public.trades for select using (true);

-- ------------------------------------------------------------------ points

create table public.points_ledger (
  id          bigint generated always as identity primary key,
  x_user_id   text not null references public.users (x_user_id),
  points      numeric not null,
  reason      text not null,                       -- e.g. 'launch', 'trade', 'holder', 'referral'
  ref         text,                                -- trade id / tx / anything that makes it idempotent
  created_at  timestamptz not null default now(),
  unique (reason, ref, x_user_id)
);
alter table public.points_ledger enable row level security;
create policy "points are public" on public.points_ledger for select using (true);

create view public.points_totals as
  select l.x_user_id, u.x_handle, sum(l.points) as points
  from public.points_ledger l join public.users u using (x_user_id)
  group by l.x_user_id, u.x_handle;
grant select on public.points_totals to anon, authenticated;

-- ------------------------------------------------------------------ indexer bookkeeping

create table public.indexer_state (
  key    text primary key,                         -- e.g. 'launchpad:99801'
  value  text not null,                            -- last processed block / cursor
  updated_at timestamptz not null default now()
);
alter table public.indexer_state enable row level security; -- private
