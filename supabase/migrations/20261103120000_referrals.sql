-- Referral codes (user, 2026-11-03): a partner protocol gets a code; the traders it brings in are tied to it, and the partner is paid
-- weekly BY HAND from the KNTQ + treasury shares on their volume (never the stakers' 40%). Written only by the `referral` edge function
-- (codes: by us, in SQL). Private: no anon/authenticated access; the app reads its own status through the function.

-- the codes we hand out
create table public.referral_codes (
  code          text primary key check (code ~ '^[A-Z0-9_]{3,20}$'),
  partner       text not null,                 -- who it's for, e.g. the protocol's name
  payout_wallet text not null,                 -- where we send their weekly payment (lower case)
  active        boolean not null default true, -- false: no new sign-ups (already tied wallets keep counting)
  created_at    timestamptz not null default now()
);

-- one code per account, the first applied, for good
create table public.referral_accounts (
  x_user_id  text primary key,
  code       text not null references public.referral_codes (code),
  created_at timestamptz not null default now()
);
create index referral_accounts_code on public.referral_accounts (code);

-- the wallets whose trades count for an account's code. A wallet joins one account only. `neuriio`: the account's own Neuriio wallet,
-- added when the code is applied; `signed`: an outside wallet whose owner signed the Verify message (kept as proof).
create table public.referral_wallets (
  wallet     text primary key check (wallet ~ '^0x[0-9a-f]{40}$'),
  x_user_id  text not null references public.referral_accounts (x_user_id),
  kind       text not null check (kind in ('neuriio', 'signed')),
  signature  text,
  added_at   timestamptz not null default now(),
  check ((kind = 'signed') = (signature is not null))
);
create index referral_wallets_user on public.referral_wallets (x_user_id);

alter table public.referral_codes enable row level security;
alter table public.referral_accounts enable row level security;
alter table public.referral_wallets enable row level security;
revoke all on public.referral_codes, public.referral_accounts, public.referral_wallets from anon, authenticated;
grant select, insert, update on public.referral_codes to service_role;
grant select, insert on public.referral_accounts, public.referral_wallets to service_role;

-- The weekly payout report: each code's volume from its wallets' trades in [p_from, p_to), counting only trades after the wallet was
-- tied. Run it in SQL, e.g. select * from referral_report(now() - interval '7 days', now());
create function public.referral_report(p_from timestamptz, p_to timestamptz)
returns table (code text, partner text, payout_wallet text, accounts bigint, traders bigint, trades bigint, volume_usd numeric)
language sql stable security invoker set search_path = public as $$
  select c.code, c.partner, c.payout_wallet,
         count(distinct a.x_user_id), count(distinct t.trader), count(t.id), coalesce(sum(t.usd_value), 0)
  from referral_codes c
  left join referral_accounts a on a.code = c.code
  left join referral_wallets w on w.x_user_id = a.x_user_id
  left join trades t on t.trader = w.wallet and t.ts >= w.added_at and t.ts >= p_from and t.ts < p_to
  group by c.code, c.partner, c.payout_wallet
  order by coalesce(sum(t.usd_value), 0) desc;
$$;
revoke all on function public.referral_report(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.referral_report(timestamptz, timestamptz) to service_role;
