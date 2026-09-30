-- FTF launch points (user, 2026-09-30): each of an FTF's 4 members gets the flat 'launch' award (50) when it launches.
-- One award per member per FTF (ledger ref = the token address), on top of any personal launch award.
-- Same as award_points() in 20260927010000_points.sql, except launches now include FTF members.

update public.points_rules set note = 'launching yourself (once), or each member of a launched FTF'
  where key = 'launch';

create or replace function public.award_points() returns integer
language plpgsql security definer set search_path = public as $$
declare n1 integer; n2 integer;
begin
  update trades t set x_user_id = u.x_user_id
    from users u where t.x_user_id is null and t.trader = u.wallet;

  insert into points_ledger (x_user_id, points, reason, ref)
    select t.x_user_id, t.usd_value * r.points, 'trade', t.id::text
    from trades t
    join points_rules r on r.key = 'volume:' || t.venue::text
    join users u on u.x_user_id = t.x_user_id
    where t.usd_value is not null and t.usd_value > 0
  on conflict (reason, ref, x_user_id) do nothing;
  get diagnostics n1 = row_count;

  insert into points_ledger (x_user_id, points, reason, ref)
    select l.x_user_id, r.points, 'launch', l.address
    from (
      select k.x_user_id, k.address from tokens k where k.x_user_id is not null
      union
      select m.x_user_id, k.address from tokens k, unnest(k.member_x_user_ids) as m(x_user_id)
      where k.kind = 'ftf'
    ) l
    join users u on u.x_user_id = l.x_user_id
    join points_rules r on r.key = 'launch'
  on conflict (reason, ref, x_user_id) do nothing;
  get diagnostics n2 = row_count;

  return n1 + n2;
end $$;
revoke all on function public.award_points() from public, anon, authenticated;
