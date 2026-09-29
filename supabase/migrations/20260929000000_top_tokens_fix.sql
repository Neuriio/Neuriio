-- refresh_top_tokens() failed on Supabase with "DELETE requires a WHERE clause" (the pg-safeupdate guard), so the
-- Top 25 snapshot never filled. Same function with an explicit WHERE.
create or replace function public.refresh_top_tokens() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from top_tokens where rank is not null;
  insert into top_tokens (rank, address, volume_usd, snapshot_at)
  select row_number() over (order by s.volume_usd desc, s.launched_at asc), s.address, s.volume_usd, now()
    from token_stats s
   order by s.volume_usd desc, s.launched_at asc
   limit 25;
end $$;
revoke all on function public.refresh_top_tokens() from public, anon, authenticated;
select public.refresh_top_tokens();
