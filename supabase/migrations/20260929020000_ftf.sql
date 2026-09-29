-- FTF ("Friends Turned Fam"): one token for exactly 4 people, launched on the same bonding curve as individual
-- tokens (Launchpad.launchFtf). Members are fixed at launch and share the creator fees equally. Being in an FTF
-- doesn't use up anyone's individual launch. Forming the group happens here first: a founder creates a draft,
-- invites people or approves "ask to join" requests, each member accepts; with 4 accepted the founder gets a signed
-- FTF pass from the `ftf` Edge Function and launches.

-- ------------------------------------------------------------------ tokens: individual or FTF
alter table public.tokens add column kind text not null default 'individual' check (kind in ('individual', 'ftf'));
alter table public.tokens add column name text;                  -- FTF display name (individuals show "@handle")
alter table public.tokens add column member_x_user_ids text[];   -- FTF: its 4 members, founder first
alter table public.tokens alter column x_user_id drop not null;  -- FTFs have no single X account
alter table public.tokens alter column category drop not null;   -- FTFs have no category
alter table public.tokens drop constraint tokens_x_user_id_key;
create unique index tokens_one_per_x_user on public.tokens (x_user_id) where kind = 'individual';
-- FTF rows use `handle` = lower-case ticker (search matches it) and `symbol` = ticker.

-- Explore's per-token view, now with kind / name / members (appended columns; same as before otherwise).
create or replace view public.token_stats with (security_invoker = true) as
with t as (
  select market, ts, block_number, log_index, venue, quote_amount, usd_value, price_hype, curve_sold
  from public.trades
  where venue in ('curve', 'pool')
),
agg as (
  select market,
         count(*) as trades,
         count(*) filter (where ts > now() - interval '24 hours') as trades_24h,
         coalesce(sum(usd_value), 0) as volume_usd,
         coalesce(sum(usd_value) filter (where ts > now() - interval '24 hours'), 0) as volume_usd_24h,
         coalesce(sum(quote_amount), 0) as volume_hype,
         max(ts) as last_trade_at
  from t group by market
),
last_price as (
  select distinct on (market) market, price_hype
  from t where price_hype is not null
  order by market, ts desc, block_number desc, log_index desc
),
price_ago as (
  select distinct on (market) market, price_hype
  from t where price_hype is not null and ts <= now() - interval '24 hours'
  order by market, ts desc, block_number desc, log_index desc
),
curve as (
  select distinct on (market) market, curve_sold
  from t where venue = 'curve' and curve_sold is not null
  order by market, ts desc, block_number desc, log_index desc
)
select k.address, k.handle, k.symbol, k.category, k.creator, k.x_user_id,
       u.x_name, u.x_pfp_url,
       k.launched_at, k.graduated, k.pair, k.graduated_at,
       coalesce(lp.price_hype, k.virtual_hype / 1073000000) as price_hype,
       coalesce(lp.price_hype, k.virtual_hype / 1073000000) * 1000000000 as mcap_hype,
       coalesce(pa.price_hype, k.virtual_hype / 1073000000) as price_hype_24h_ago,
       case when k.graduated then 1 else least(coalesce(c.curve_sold, 0) / 793100000, 1) end as curve_progress,
       coalesce(a.trades, 0) as trades,
       coalesce(a.trades_24h, 0) as trades_24h,
       coalesce(a.volume_usd, 0) as volume_usd,
       coalesce(a.volume_usd_24h, 0) as volume_usd_24h,
       coalesce(a.volume_hype, 0) as volume_hype,
       a.last_trade_at,
       k.kind, k.name, k.member_x_user_ids
from public.tokens k
left join public.user_cards u using (x_user_id)
left join agg a on a.market = k.address
left join last_price lp on lp.market = k.address
left join price_ago pa on pa.market = k.address
left join curve c on c.market = k.address;
grant select on public.token_stats to anon, authenticated;

-- ------------------------------------------------------------------ forming an FTF (before launch)
create table public.ftf_drafts (
  id             uuid primary key default gen_random_uuid(),
  founder        text not null references public.users (x_user_id),
  name           text not null,
  ticker         text not null,
  profile        text not null,          -- canonical profile JSON (hashed into the pass)
  profile_hash   text not null,
  status         text not null default 'open' check (status in ('open', 'launched', 'cancelled')),
  token          text,                   -- set by the indexer when it launches
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- a ticker can only be claimed by one open draft at a time (the contract enforces uniqueness among launched FTFs)
create unique index ftf_drafts_open_ticker on public.ftf_drafts (upper(ticker)) where status = 'open';
create index ftf_drafts_founder on public.ftf_drafts (founder, status);

create table public.ftf_members (
  draft_id    uuid not null references public.ftf_drafts (id) on delete cascade,
  x_user_id   text not null references public.users (x_user_id),
  role        text not null check (role in ('founder', 'member')),
  -- invited: the founder asked them; requested: they asked to join; accepted: in (founder approved / they accepted)
  status      text not null check (status in ('invited', 'requested', 'accepted', 'declined')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (draft_id, x_user_id)
);
create index ftf_members_user on public.ftf_members (x_user_id, status);

-- public read (browse open FTFs, see who's in, ask to join); writes only through the `ftf` Edge Function (service role)
alter table public.ftf_drafts enable row level security;
alter table public.ftf_members enable row level security;
create policy "ftf drafts are public" on public.ftf_drafts for select using (true);
create policy "ftf members are public" on public.ftf_members for select using (true);
