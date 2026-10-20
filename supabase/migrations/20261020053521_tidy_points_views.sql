-- Security advisor follow-up (2026-10-20): points_totals was never used by the app, backend or keeper: dropped.
-- leaderboard stays a security-definer view on purpose (public X profile + points only, no wallets: the app's Points
-- panel reads it logged out, and users / points_ledger stay private), but visitors only get to read it.
drop view if exists public.points_totals;
revoke all on public.leaderboard from anon, authenticated;
grant select on public.leaderboard to anon, authenticated;
