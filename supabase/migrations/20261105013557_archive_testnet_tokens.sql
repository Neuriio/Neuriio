-- Mainnet starts clean (user, 2026-11-04): every token so far launched on Elysium testnet. Copy them, their trades and chart
-- candles, and the FTF drafts that launched them, into the private `archive` schema (not exposed through the API), then remove
-- them from the live tables, so Explore, Trending and the anti-vamp ticker check start from zero. Restorable from archive.*.
-- APPLIED 2026-11-04 (61 tokens, 3,073 trades, 2,575 candles, 2 launched FTF drafts).
create schema if not exists archive;
revoke all on schema archive from anon, authenticated;

create table archive.testnet_tokens as select * from public.tokens;
create table archive.testnet_trades as select * from public.trades where venue in ('curve', 'pool');
create table archive.testnet_candles as select * from public.candles;
create table archive.testnet_ftf_drafts as select * from public.ftf_drafts where status = 'launched';

delete from public.candles;
delete from public.trades where venue in ('curve', 'pool');
delete from public.ftf_drafts where status = 'launched';
delete from public.tokens;
