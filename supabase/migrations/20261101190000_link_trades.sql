-- Trader activity stays tracked (user, 2026-11-01): the first piece of how Neuriio will be earned, not displayed anywhere.
-- This is the part of award_points() that tags trades with their trader's X account, without the points. Returns rows tagged.
create or replace function public.link_trades() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update trades t set x_user_id = u.x_user_id
    from users u where t.x_user_id is null and t.trader = u.wallet;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.link_trades() from public, anon, authenticated;
