-- One-off (2026-09-30): the Launchpad was redeployed (0x440c…) and $VON_HL relaunched there (0xb296…), but the previous
-- $VON_HL row (0x00f3…, Launchpad 0x3c1b…) blocks it: tokens allows one personal token per X account, so the indexer
-- fails every minute ("tokens_one_per_x_user"). Removes the stale token and everything tied to it. Users are kept.
begin;
create temp table old_tok(a text) on commit drop;
insert into old_tok values ('0x00f3be059e3a5f1d79ae71a55b872bf47ae0dad0');
delete from points_ledger where (reason = 'launch' and ref in (select a from old_tok))
  or (reason = 'trade' and ref in (select id::text from trades where market in (select a from old_tok)));
delete from candles where token in (select a from old_tok);
delete from top_tokens where address in (select a from old_tok);
delete from trades where market in (select a from old_tok);
delete from tokens where address in (select a from old_tok);
commit;
