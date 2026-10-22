-- Security review 2026-10-22: the browser roles (anon, authenticated) only ever READ. Every write goes through an
-- Edge Function with the secret key (service_role, unaffected). RLS already blocked every write; these privileges
-- were Supabase's defaults. SELECT (table- and column-level) is left exactly as it was.
do $$
declare
  r record;
begin
  for r in select c.relname
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'v', 'p') loop
    execute format('revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated', r.relname);
  end loop;
  -- column-level grants of the same kinds (a table-level REVOKE leaves those)
  for r in select distinct table_name, column_name, privilege_type, grantee
             from information_schema.column_privileges
            where table_schema = 'public' and grantee in ('anon', 'authenticated')
              and privilege_type in ('INSERT', 'UPDATE', 'REFERENCES') loop
    execute format('revoke %s (%I) on public.%I from %I', r.privilege_type, r.column_name, r.table_name, r.grantee);
  end loop;
end $$;

-- and for tables and views that later migrations create (they run as postgres)
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, trigger, references on tables from anon, authenticated;
