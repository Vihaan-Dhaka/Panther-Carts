-- Supabase stopped automatically exposing new public-schema tables to Data API
-- roles in 2026. Panther Carts accesses these tables only from trusted server
-- operations using the service role, so grant that role the required table and
-- sequence privileges explicitly without exposing anything to anon or
-- authenticated users. Standalone PostgreSQL tests do not define service_role;
-- the conditional keeps the migrations portable to that supported environment.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant select, insert, update, delete on all tables in schema public to service_role';
    execute 'grant usage, select on all sequences in schema public to service_role';

    -- Migrations and Dashboard-created objects are owned by postgres on hosted
    -- Supabase. Keep future tables server-accessible under the new opt-in model.
    execute 'alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to service_role';
    execute 'alter default privileges for role postgres in schema public grant usage, select on sequences to service_role';
  end if;
end;
$$;
