-- Launched-token trading points: 100 points per $100k traded (was 100 per $1M), user 2026-10-10.
-- Applies to trades awarded from now on; points already in the ledger never change.
update public.points_rules
   set points = 0.001, note = '100 points per $100k traded (launched tokens, bonding curve)', updated_at = now()
 where key = 'volume:curve';
update public.points_rules
   set points = 0.001, note = '100 points per $100k traded (launched tokens, graduated pool)', updated_at = now()
 where key = 'volume:pool';
