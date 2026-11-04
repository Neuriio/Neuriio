-- Explore's "Platform fees" counter (user, 2026-11-03): every USDC fee that reached our fee wallet from Ascend, lifetime, as the fee
-- router (keeper/src/fees) records them in fee_receipts. Only the total is public; the receipts stay service-role only.
create function public.platform_fees() returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount::numeric), 0) / 1e6 from fee_receipts; -- USDC base units -> USDC
$$;
revoke all on function public.platform_fees() from public;
grant execute on function public.platform_fees() to anon, authenticated;
