-- ContentPilot AI — M1: database health probe used by GET /api/health.
--
-- Executes a real query on the Postgres server and returns its clock and version.
-- It reads no application tables, so it is safe to expose to the anon role.

create function public.health_check()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'server_time', now(),
    'server_version', current_setting('server_version_num')::int
  );
$$;

revoke all on function public.health_check() from public;
grant execute on function public.health_check() to anon, authenticated;
