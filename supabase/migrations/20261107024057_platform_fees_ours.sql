-- APPLIED 2026-11-07 (mainnet backend switch).
-- Platform fees counter, hardened (security pass 2026-11-04): count only fees matched to one of our launches. The fee router now
-- drops BuilderPaid events from contracts that aren't real Ascend escrows (anyone can emit one), and unmatched receipts (a real
-- escrow that isn't ours) are held, not ours to show.
create or replace function public.platform_fees() returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount::numeric), 0) / 1e6 from fee_receipts where token is not null; -- USDC base units -> USDC
$$;
