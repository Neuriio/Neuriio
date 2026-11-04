-- Anti-vamping (user, 2026-11-01): before a pass is signed, the launch must not share its ticker's first 4 characters with a launched
-- token, or copy a launched token's picture. A signed pass holds both until it expires, so a second person can't slip in between the
-- pass and the launch. Pictures are compared by what they look like, not their URL (supabase/functions/_shared/pfpHash.ts: the hashes here
-- only shortlist suspects, and that code confirms them). This is a backend rule: the launcher contract doesn't know about it, but no launch happens without our signature.

-- The same as tickerPrefix in supabase/functions/_shared/launchPass.ts.
create or replace function public.ticker_prefix(p_ticker text) returns text
language sql immutable set search_path = '' as $$
  select left(translate(regexp_replace(upper(p_ticker), '[^A-Z0-9]', '', 'g'), '01', 'OI'), 4);
$$;

create table public.launch_claims (
  id bigint generated always as identity primary key,
  ticker text not null,                    -- upper case
  prefix text generated always as (public.ticker_prefix(ticker)) stored,
  owners text[] not null,                  -- X user IDs: the creator, or an FTF's members
  pfp_grid bit(144)[],                     -- a hash per window of the picture, the whole picture first; null: nothing to compare
  pfp_thumb bytea,                         -- 64 x 64 greys, to confirm a suspect
  deadline timestamptz not null,           -- the pass's: past it, a claim only counts if its token launched
  created_at timestamptz not null default now()
);
create index launch_claims_prefix on public.launch_claims (prefix);
create index launch_claims_ticker on public.launch_claims (ticker);
alter table public.launch_claims enable row level security;
revoke all on public.launch_claims from anon, authenticated;

create index tokens_ticker_prefix on public.tokens (public.ticker_prefix(symbol));

-- Returns {"conflict": "ticker", "with": <their ticker>}, or {"conflict": null, "claim": <id, if held>, "suspects": [...]}: the claims whose
-- picture comes close, each with its closest windows ("crop": mine looks like a window of theirs; "mirror": the same, mirrored; "border":
-- theirs looks like a window of mine). Claims run one at a time, so each only sees earlier ones. People may retry their own launch, and
-- an FTF may use a picture its own members launched with.
create or replace function public.claim_launch(
  p_ticker text, p_owners text[], p_grid text[], p_mirror text, p_thumb text, p_max_bits integer, p_deadline timestamptz, p_commit boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t text := upper(p_ticker);
  p text := public.ticker_prefix(p_ticker);
  reg text := (select lower(value) from app_config where key = 'registry');
  grid bit(144)[] := p_grid::bit(144)[];
  taken text;
  suspects jsonb := '[]'::jsonb;
  mine bigint;
begin
  perform pg_advisory_xact_lock(hashtext('launch_claims'));

  select k.symbol into taken from tokens k
    where public.ticker_prefix(k.symbol) = p and lower(k.registry) = reg limit 1;
  if taken is null then
    select c.ticker into taken from launch_claims c
      where c.prefix = p and c.deadline > now() and not (c.ticker = t and c.owners && p_owners) limit 1;
  end if;
  if taken is not null then
    return jsonb_build_object('conflict', 'ticker', 'with', taken);
  end if;

  if grid is not null then
    select coalesce(jsonb_agg(jsonb_build_object('ticker', s.ticker, 'thumb', encode(s.pfp_thumb, 'base64'), 'hits', s.hits) order by s.best), '[]'::jsonb)
      into suspects
      from (
        select c.ticker, c.pfp_thumb, h.best, h.hits
          from launch_claims c
          cross join lateral (
            select min(x.d) as best, jsonb_agg(jsonb_build_object('w', x.w, 'kind', x.kind) order by x.d) as hits
              from (
                -- at most 5 windows per direction: the closest are the ones worth confirming
                (select i::int as w, least(bit_count(v # grid[1]), bit_count(v # p_mirror::bit(144))) as d,
                        case when bit_count(v # grid[1]) <= bit_count(v # p_mirror::bit(144)) then 'crop' else 'mirror' end as kind
                   from unnest(c.pfp_grid) with ordinality g(v, i)
                  where least(bit_count(v # grid[1]), bit_count(v # p_mirror::bit(144))) <= p_max_bits
                  order by 2 limit 5)
                union all
                (select i::int, bit_count(v # c.pfp_grid[1]), 'border'
                   from unnest(grid) with ordinality g(v, i)
                  where bit_count(v # c.pfp_grid[1]) <= p_max_bits
                  order by 2 limit 5)
              ) x
          ) h
         where c.pfp_grid is not null
           and h.hits is not null
           and not (c.owners && p_owners)
           and (c.deadline > now() or exists (select 1 from tokens k where k.symbol = c.ticker and lower(k.registry) = reg))
         order by h.best
         limit 200
      ) s;
  end if;

  if p_commit then
    delete from launch_claims c where c.ticker = t and c.owners && p_owners; -- a retry replaces its own earlier claim
    insert into launch_claims (ticker, owners, pfp_grid, pfp_thumb, deadline)
      values (t, p_owners, grid, decode(p_thumb, 'base64'), p_deadline)
      returning id into mine;
  end if;
  return jsonb_build_object('conflict', null, 'claim', mine, 'suspects', suspects);
end $$;
revoke all on function public.claim_launch(text, text[], text[], text, text, integer, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.claim_launch(text, text[], text[], text, text, integer, timestamptz, boolean) to service_role;
