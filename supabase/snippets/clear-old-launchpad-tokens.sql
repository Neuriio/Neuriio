-- One-off (2026-09-30): remove the two tokens from the previous Launchpad (0x6ef0…cb53) so @von_hl can relaunch
-- on the current one (tokens allows one personal token per X account). Users rows are kept.
-- Counts before: 10 trades, 13 candles, 2 top_tokens rows, 5 points_ledger rows.
begin;
create temp table old_tok(a text) on commit drop;
insert into old_tok values ('0xab1ee2ded50410988921566c724f957a6b96aef3'), ('0xfc448fabb10fe5b25f3769b3809b42c28d70a715');
delete from points_ledger where (reason = 'launch' and ref in (select a from old_tok))
  or (reason = 'trade' and ref in (select id::text from trades where market in (select a from old_tok)));
delete from candles where token in (select a from old_tok);
delete from top_tokens where address in (select a from old_tok);
delete from trades where market in (select a from old_tok);
delete from tokens where address in (select a from old_tok);
commit;
