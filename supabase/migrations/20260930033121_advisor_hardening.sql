-- Security sweep 2026-09-30 (Supabase advisors): pin candle_bucket's search_path, and take the API off
-- rls_auto_enable() (Supabase's own event-trigger function; callable as /rest/v1/rpc but does nothing there).
-- Guarded so the migration also runs where that function doesn't exist (local test databases).
alter function public.candle_bucket(timestamp with time zone, integer) set search_path = pg_catalog, public;
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
