-- Removes the old points model (user, 2026-11-01): Neuriio starts from scratch, with new earning rules to come.
-- Permanently deletes every user's points; the trades themselves stay. Run after 20261101190000_link_trades.sql and after
-- deploying the indexer and register functions that no longer use these.
drop view if exists public.leaderboard;
drop function if exists public.award_points();
drop table if exists public.points_ledger;
drop table if exists public.points_rules;
