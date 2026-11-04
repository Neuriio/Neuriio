-- Launch check (user, 2026-11-01): who bought each token right after it launched, and which of those wallets are tied together. Worked out
-- from public chain data by keeper/launch-check.mjs. `summary` is what Explore shows, `saved` what later checks reuse. Public: it says
-- nothing the chain doesn't.
create table public.launch_checks (
  token text primary key,    -- lower case
  summary jsonb,             -- null: no buyers yet
  saved jsonb,
  next_check timestamptz not null,
  checked_at timestamptz not null default now()
);
create index launch_checks_next on public.launch_checks (next_check);
alter table public.launch_checks enable row level security;
create policy "launch checks are public" on public.launch_checks for select to anon, authenticated using (true);
grant select on public.launch_checks to anon, authenticated;
grant select, insert, update on public.launch_checks to service_role;
