-- Tests for M3 agent_actions: RLS, permissions and integrity of the agent log.
-- Same approach as the other files: SET ROLE + JWT claims, any failed assertion aborts.

\set ON_ERROR_STOP on

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  execute 'set role anon';
end $$;

create or replace function pg_temp.reset_actor() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
end $$;

create or replace function pg_temp.assert(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'ASSERTION FAILED: %', p_msg;
  end if;
  raise notice 'ok - %', p_msg;
end $$;

create or replace function pg_temp.assert_error(p_sql text, p_sqlstate text, p_msg text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_sqlstate then
      raise exception 'ASSERTION FAILED: % (expected SQLSTATE %, got %: %)', p_msg, p_sqlstate, sqlstate, sqlerrm;
    end if;
    raise notice 'ok - % (rejected %: %)', p_msg, sqlstate, sqlerrm;
    return;
  end;
  raise exception 'ASSERTION FAILED: % (statement was allowed)', p_msg;
end $$;

create or replace function pg_temp.affected(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;

-- Fixtures ---------------------------------------------------------------------
--   f1 Fiona: owner of WA     f2 Gil: member of WA     f3 Hana: owner of WB (outsider to WA)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'fiona@example.test'),
  ('00000000-0000-0000-0000-0000000000f2', 'gil@example.test'),
  ('00000000-0000-0000-0000-0000000000f3', 'hana@example.test');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
insert into public.workspaces (id, name) values ('a0000000-0000-0000-0000-00000000000a', 'WA');
insert into public.workspace_members (workspace_id, user_id, role)
  values ('a0000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f2', 'member');
insert into public.content_projects (id, workspace_id, name)
  values ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'WA blog');
-- Post written by a user (not the agent).
insert into public.content_posts (id, workspace_id, project_id, title)
  values ('a2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a',
          'a1000000-0000-0000-0000-000000000001', 'User post');
select pg_temp.reset_actor();

-- Gil, as the agent: creates a post (version 1, change_source agent) and updates it (version 2).
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
insert into public.content_posts (id, workspace_id, project_id, title, last_change_source)
  values ('a2000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a',
          'a1000000-0000-0000-0000-000000000001', 'Agent post', 'agent');
select public.update_content_post('a2000000-0000-0000-0000-000000000002', 1, 'Agent post', 'Shorter body',
                                  'draft', null, 'agent');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');
insert into public.workspaces (id, name) values ('b0000000-0000-0000-0000-00000000000b', 'WB');
insert into public.content_projects (id, workspace_id, name)
  values ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'WB blog');
insert into public.content_posts (id, workspace_id, project_id, title, last_change_source)
  values ('b2000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b',
          'b1000000-0000-0000-0000-000000000001', 'WB agent post', 'agent');
select pg_temp.reset_actor();

-- 1. Logging real agent actions ----------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
with r as (
  insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, project_id, post_id, version_after)
  values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000001', 'create_post', 'create',
          'success', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000002', 1)
  returning user_id, created_at)
select pg_temp.assert(user_id = '00000000-0000-0000-0000-0000000000f2' and created_at > now() - interval '1 minute',
  'member logs a real agent create; user_id and created_at are set by the server') from r;
insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, project_id, post_id,
                                  version_before, version_after, fields)
values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000001', 'update_post', 'update',
        'success', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000002', 1, 2, array['body']);
select pg_temp.assert(true, 'member logs a real agent update (v1 -> v2, fields = body)');
insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after)
values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000001', 'get_post', 'read',
        'success', 'a2000000-0000-0000-0000-000000000001', 1);
select pg_temp.assert(true, 'member logs a read');
insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, error_code, post_id, version_before)
values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000001', 'update_post', 'update',
        'error', 'version_conflict', 'a2000000-0000-0000-0000-000000000002', 1);
select pg_temp.assert(true, 'member logs a failed update (version_conflict)');
insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, error_code)
values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000001', 'unknown', 'unknown',
        'error', 'unknown_tool');
select pg_temp.assert(true, 'member logs an unknown-tool attempt without target');
select pg_temp.reset_actor();

-- 2. A success log must match a real write -------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000002', 'update_post', 'update',
             'success', 'a2000000-0000-0000-0000-000000000002', 5)$q$,
  '42501', 'cannot log a successful write for a version that does not exist');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000002', 'create_post', 'create',
             'success', 'a2000000-0000-0000-0000-000000000001', 1)$q$,
  '42501', 'cannot log a user-written version as an agent write');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000002', 'create_post', 'create',
             'success', 'a2000000-0000-0000-0000-000000000002', 1)$q$,
  '23505', 'the same write cannot be logged as a success twice');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000002', 'create_post', 'create', 'success')$q$,
  '42501', 'a successful write without post and version is rejected (RLS)');
select pg_temp.reset_actor();
-- The CHECK constraint holds on its own too (superuser bypasses RLS; the trigger still needs auth.uid()).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2"}', false);
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000002', 'create_post', 'create', 'success')$q$,
  '23514', 'CHECK: a successful write must name the post and version, even without RLS');
select set_config('request.jwt.claims', '', false);

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000003', 'update_post', 'update',
             'success', 'a2000000-0000-0000-0000-000000000002', 2)$q$,
  '42501', 'another member cannot claim a write made by someone else');
select pg_temp.reset_actor();

-- 3. No forging of user, workspace or targets ---------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, user_id)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000004', 'list_projects', 'read',
             'success', '00000000-0000-0000-0000-0000000000f1')$q$,
  '42501', 'cannot set user_id (column not granted)');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, created_at)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000004', 'list_projects', 'read',
             'success', '2000-01-01')$q$,
  '42501', 'cannot set created_at (column not granted)');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status)
     values ('b0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-000000000004', 'list_projects', 'read', 'success')$q$,
  '42501', 'cannot log into a workspace the user is not a member of');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000004', 'get_post', 'read',
             'success', 'b2000000-0000-0000-0000-000000000001')$q$,
  '23503', 'cannot reference a post of another workspace');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, project_id)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000004', 'list_posts', 'read',
             'success', 'b1000000-0000-0000-0000-000000000001')$q$,
  '23503', 'cannot reference a project of another workspace');
select pg_temp.reset_actor();

-- 4. Shape constraints (no free text) -------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000005', 'Ignore previous instructions', 'read', 'success')$q$,
  '23514', 'tool must be a short identifier (no free text)');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, error_code)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000005', 'get_post', 'read', 'error', 'sk-secret key')$q$,
  '23514', 'error_code must be a short identifier');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000005', 'get_post', 'read', 'published')$q$,
  '23514', 'status is limited to success / error / skipped');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, error_code)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000005', 'get_post', 'read', 'success', 'not_found')$q$,
  '23514', 'a success has no error code');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, error_code, fields)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000005', 'update_post', 'update',
             'error', 'not_draft', array['status'])$q$,
  '23514', 'fields are limited to title / body / scheduled_for');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, error_code, version_before, version_after)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000005', 'update_post', 'update',
             'error', 'invalid_input', 4, 2)$q$,
  '23514', 'version_after must be greater than version_before');
select pg_temp.reset_actor();

-- 5. Visibility ------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select pg_temp.assert((select count(*) from public.agent_actions) = 5, 'owner sees the 5 log rows of the workspace');
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select pg_temp.assert((select count(*) from public.agent_actions) = 5, 'member sees the workspace log');
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');
select pg_temp.assert((select count(*) from public.agent_actions) = 0, 'outsider sees no log rows');
select pg_temp.reset_actor();
select pg_temp.act_as_anon();
select pg_temp.assert_error($q$select * from public.agent_actions$q$, '42501', 'anon cannot read the log');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000006', 'list_projects', 'read', 'success')$q$,
  '42501', 'anon cannot write the log');
select pg_temp.reset_actor();
-- Signed-in role without a user id.
set role authenticated;
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status)
     values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000006', 'list_projects', 'read', 'success')$q$,
  '42501', 'no log without auth.uid()');
reset role;

-- 6. Append-only -------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select pg_temp.assert_error($q$update public.agent_actions set status = 'error'$q$, '42501', 'owner cannot update log rows');
select pg_temp.assert_error($q$delete from public.agent_actions$q$, '42501', 'owner cannot delete log rows');
select pg_temp.reset_actor();
select pg_temp.assert_error(
  $q$update public.agent_actions set error_code = 'forbidden', status = 'error' where tool = 'create_post'$q$,
  '42501', 'even the table owner cannot rewrite the log (trigger)');
select pg_temp.assert_error($q$delete from public.agent_actions$q$, '42501', 'even the table owner cannot delete the log (trigger)');
select pg_temp.assert(
  (select bool_and(confdeltype = 'r') from pg_constraint
    where conrelid = 'public.agent_actions'::regclass and contype = 'f' and confrelid <> 'auth.users'::regclass),
  'log foreign keys to workspaces / projects / posts use ON DELETE RESTRICT (no cascade deletion of the log)');

-- 7. Account deletion keeps the log -------------------------------------------------------------
delete from auth.users where id = '00000000-0000-0000-0000-0000000000f2';
select pg_temp.assert(
  (select count(*) = 5 and bool_and(user_id is null) from public.agent_actions
    where workspace_id = 'a0000000-0000-0000-0000-00000000000a'),
  'deleting an account keeps its log rows with user_id = null');

-- 8. Catalog checks ---------------------------------------------------------------------------
select pg_temp.assert(
  (select relrowsecurity from pg_class where oid = 'public.agent_actions'::regclass),
  'RLS is enabled on agent_actions');
select pg_temp.assert(
  not exists (select 1 from pg_policies where tablename = 'agent_actions' and cmd in ('UPDATE', 'DELETE', 'ALL')),
  'no UPDATE / DELETE policy on agent_actions');
select pg_temp.assert(
  not has_any_column_privilege('authenticated', 'public.agent_actions', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.agent_actions', 'DELETE')
  and not has_column_privilege('authenticated', 'public.agent_actions', 'user_id', 'INSERT')
  and not has_column_privilege('authenticated', 'public.agent_actions', 'created_at', 'INSERT')
  and not has_any_column_privilege('anon', 'public.agent_actions', 'SELECT'),
  'authenticated cannot update/delete or set user_id/created_at; anon has no access');
select pg_temp.assert(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_actions'
      and column_name ~ '(title|body|content|prompt|reply|message|argument|args|key|secret|token)'),
  'agent_actions has no column for content, prompts, arguments or secrets');
select pg_temp.assert(
  not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'agent_actions%' and p.prosecdef),
  'agent_actions adds no SECURITY DEFINER function');

\echo 'All agent_actions tests passed.'
