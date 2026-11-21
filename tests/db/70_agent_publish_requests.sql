-- Tests for M4.6c: agent_actions rows for agent publish requests.

\set ON_ERROR_STOP on

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.headers', '', false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;
create or replace function pg_temp.act_as_agent_of(p_user uuid) returns void language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform set_config('request.headers', '{"x-contentpilot-actor":"agent"}', false);
end $$;
create or replace function pg_temp.reset_actor() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
  perform set_config('request.headers', '', false);
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

-- Fixtures ---------------------------------------------------------------------
--   7a1 owner of WX, 7a2 member of WX, 7a3 owner of WY (outsider)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000007a1', 'agent-owner@example.test'),
  ('00000000-0000-0000-0000-0000000007a2', 'agent-member@example.test'),
  ('00000000-0000-0000-0000-0000000007a3', 'agent-outsider@example.test');

select pg_temp.act_as('00000000-0000-0000-0000-0000000007a1');
insert into public.workspaces (id, name) values ('7a000000-0000-0000-0000-000000000001', 'WX');
insert into public.workspace_members (workspace_id, user_id, role)
  values ('7a000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000007a2', 'member');
insert into public.content_projects (id, workspace_id, name)
  values ('7a100000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000001', 'Blog');
insert into public.content_posts (id, workspace_id, project_id, title)
select ('7a200000-0000-0000-0000-00000000000' || n)::uuid, '7a000000-0000-0000-0000-000000000001',
       '7a100000-0000-0000-0000-000000000001', 'Post ' || n
from generate_series(1, 4) n;
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000007a3');
insert into public.workspaces (id, name) values ('7a000000-0000-0000-0000-000000000002', 'WY');
insert into public.content_projects (id, workspace_id, name)
  values ('7a100000-0000-0000-0000-000000000002', '7a000000-0000-0000-0000-000000000002', 'Blog Y');
insert into public.content_posts (id, workspace_id, project_id, title)
  values ('7a200000-0000-0000-0000-000000000009', '7a000000-0000-0000-0000-000000000002', '7a100000-0000-0000-0000-000000000002', 'Y');
select pg_temp.reset_actor();

select (select id from public.publishing_destinations where workspace_id = '7a000000-0000-0000-0000-000000000001') as dest_x,
       (select id from public.publishing_destinations where workspace_id = '7a000000-0000-0000-0000-000000000002') as dest_y \gset

-- The agent (in the member's session) files a request for post 1, turn T1.
select pg_temp.act_as_agent_of('00000000-0000-0000-0000-0000000007a2');
select public.request_post_publish('7a200000-0000-0000-0000-000000000001', 1, 'agent',
  '7a900000-0000-0000-0000-0000000000f1'::text::uuid, null, :'dest_x');
select pg_temp.reset_actor();
-- A user (not the agent) request for post 2.
select pg_temp.act_as('00000000-0000-0000-0000-0000000007a2');
select public.request_post_publish('7a200000-0000-0000-0000-000000000002', 1);
select pg_temp.reset_actor();
-- The outsider's agent request in WY.
select pg_temp.act_as_agent_of('00000000-0000-0000-0000-0000000007a3');
select public.request_post_publish('7a200000-0000-0000-0000-000000000009', 1, 'agent',
  '7a900000-0000-0000-0000-0000000000f9'::text::uuid, null, :'dest_y');
select pg_temp.reset_actor();

select (select id from public.content_publish_requests where post_id = '7a200000-0000-0000-0000-000000000001') as req_agent,
       (select id from public.content_publish_requests where post_id = '7a200000-0000-0000-0000-000000000002') as req_user,
       (select id from public.content_publish_requests where post_id = '7a200000-0000-0000-0000-000000000009') as req_other \gset

-- 1. Structure ---------------------------------------------------------------------
select pg_temp.assert(
  has_column_privilege('authenticated', 'public.agent_actions', 'request_id', 'INSERT')
  and not has_any_column_privilege('authenticated', 'public.agent_actions', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.agent_actions', 'DELETE')
  and not has_column_privilege('authenticated', 'public.agent_actions', 'user_id', 'INSERT'),
  'request_id insertable; still no UPDATE/DELETE and no user_id from clients');
select pg_temp.assert(
  (select status = 'pending' and request_source = 'agent' and agent_turn_id = '7a900000-0000-0000-0000-0000000000f1'::text::uuid
     from public.content_publish_requests where id = :'req_agent')
  and (select status = 'draft' from public.content_posts where id = '7a200000-0000-0000-0000-000000000001'),
  'the agent request is pending and the post is not published');

-- 2. A real agent publish request is logged -------------------------------------------
select pg_temp.act_as_agent_of('00000000-0000-0000-0000-0000000007a2');
insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, project_id, post_id, version_after, request_id)
values ('7a000000-0000-0000-0000-000000000001', '7a900000-0000-0000-0000-0000000000f1'::text::uuid, 'request_publish',
        'publish_request', 'success', '7a100000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000001', 1, :'req_agent');
select pg_temp.assert(
  (select user_id = '00000000-0000-0000-0000-0000000007a2' from public.agent_actions where request_id = :'req_agent'),
  'the success row is recorded for the acting user (user_id from auth.uid())');
select pg_temp.assert_error(
  format($q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after, request_id)
            values ('7a000000-0000-0000-0000-000000000001', '7a900000-0000-0000-0000-0000000000f1'::text::uuid, 'request_publish',
                    'publish_request', 'success', '7a200000-0000-0000-0000-000000000001', 1, %L)$q$, :'req_agent'),
  '23505', 'only one success row per publish request');

-- 3. Fake audit rows are refused -------------------------------------------------------
select pg_temp.assert_error(
  format($q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after, request_id)
            values ('7a000000-0000-0000-0000-000000000001', gen_random_uuid(), 'request_publish',
                    'publish_request', 'success', '7a200000-0000-0000-0000-000000000002', 1, %L)$q$, :'req_user'),
  '42501', 'cannot log a request the agent did not make (user request)');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000007a1');
select pg_temp.assert_error(
  format($q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after, request_id)
            values ('7a000000-0000-0000-0000-000000000001', '7a900000-0000-0000-0000-0000000000f1'::text::uuid, 'request_publish',
                    'publish_request', 'success', '7a200000-0000-0000-0000-000000000003', 1, %L)$q$, :'req_agent'),
  '42501', 'another user (even the owner) cannot claim the member''s agent request');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000007a2');
select pg_temp.assert_error(
  format($q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after, request_id)
            values ('7a000000-0000-0000-0000-000000000001', gen_random_uuid(), 'request_publish',
                    'publish_request', 'success', '7a200000-0000-0000-0000-000000000001', 1, %L)$q$, :'req_agent'),
  '42501', 'a different turn id cannot claim the request');
select pg_temp.assert_error(
  format($q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after, request_id)
            values ('7a000000-0000-0000-0000-000000000001', '7a900000-0000-0000-0000-0000000000f1'::text::uuid, 'request_publish',
                    'publish_request', 'success', '7a200000-0000-0000-0000-000000000003', 1, %L)$q$, :'req_agent'),
  '42501', 'a different post cannot claim the request');
select pg_temp.assert_error(
  format($q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after, request_id)
            values ('7a000000-0000-0000-0000-000000000001', '7a900000-0000-0000-0000-0000000000f1'::text::uuid, 'request_publish',
                    'publish_request', 'success', '7a200000-0000-0000-0000-000000000001', 2, %L)$q$, :'req_agent'),
  '42501', 'a different version cannot claim the request');
select pg_temp.assert_error(
  format($q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after, request_id)
            values ('7a000000-0000-0000-0000-000000000001', '7a900000-0000-0000-0000-0000000000f9'::text::uuid, 'request_publish',
                    'publish_request', 'success', '7a200000-0000-0000-0000-000000000001', 1, %L)$q$, :'req_other'),
  '42501', 'a request of another workspace cannot be referenced');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after)
     values ('7a000000-0000-0000-0000-000000000001', gen_random_uuid(), 'request_publish',
             'publish_request', 'success', '7a200000-0000-0000-0000-000000000001', 1)$q$,
  '42501', 'a success row without its request is refused (RLS)');
select pg_temp.reset_actor();
-- The CHECK itself holds even for the superuser (who bypasses RLS).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007a2","role":"authenticated"}', false);
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after)
     values ('7a000000-0000-0000-0000-000000000001', gen_random_uuid(), 'request_publish',
             'publish_request', 'success', '7a200000-0000-0000-0000-000000000001', 1)$q$,
  '23514', 'CHECK: a success publish_request row must name its request');
select set_config('request.jwt.claims', '', false);
select pg_temp.act_as('00000000-0000-0000-0000-0000000007a2');
select pg_temp.assert_error(
  format($q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after, request_id)
            values ('7a000000-0000-0000-0000-000000000001', gen_random_uuid(), 'get_post',
                    'read', 'success', '7a200000-0000-0000-0000-000000000001', 1, %L)$q$, :'req_agent'),
  '23514', 'only publish_request rows may reference a request');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, error_code)
     values ('7a000000-0000-0000-0000-000000000001', gen_random_uuid(), 'approve_publish', 'approve', 'error', 'forbidden')$q$,
  '23514', 'no other kind (e.g. approve) exists');
-- Failed / skipped publish attempts are logged without a request.
with r as (
  insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, error_code, post_id)
  values ('7a000000-0000-0000-0000-000000000001', gen_random_uuid(), 'request_publish', 'publish_request', 'error',
          'request_pending_exists', '7a200000-0000-0000-0000-000000000001')
  returning 1
)
select pg_temp.assert((select count(*) = 1 from r), 'a failed publish attempt is logged (error code, no request)');
select pg_temp.reset_actor();

-- 4. The log stays append-only, including request_id ---------------------------------------
select pg_temp.assert_error(
  format($q$update public.agent_actions set request_id = %L where request_id = %L$q$, :'req_other', :'req_agent'),
  '42501', 'request_id cannot be changed, even by the superuser');
select pg_temp.assert_error(
  format($q$delete from public.agent_actions where request_id = %L$q$, :'req_agent'),
  '42501', 'publish request audit rows cannot be deleted');

-- 5. M3 guarantees are unchanged ---------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000007a2');
select pg_temp.assert_error(
  $q$insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, post_id, version_after)
     values ('7a000000-0000-0000-0000-000000000001', gen_random_uuid(), 'update_post', 'update', 'success',
             '7a200000-0000-0000-0000-000000000004', 5)$q$,
  '42501', 'M3: a fake successful update is still refused');
insert into public.content_posts (id, workspace_id, project_id, title, last_change_source)
  values ('7a200000-0000-0000-0000-000000000005', '7a000000-0000-0000-0000-000000000001', '7a100000-0000-0000-0000-000000000001', 'By agent', 'agent');
with r as (
  insert into public.agent_actions (workspace_id, turn_id, tool, kind, status, project_id, post_id, version_after)
  values ('7a000000-0000-0000-0000-000000000001', gen_random_uuid(), 'create_post', 'create', 'success',
          '7a100000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000005', 1)
  returning 1
)
select pg_temp.assert((select count(*) = 1 from r), 'M3: a real agent create is still logged');
select pg_temp.reset_actor();

-- 6. The agent can still neither approve nor reject --------------------------------------------
select pg_temp.act_as_agent_of('00000000-0000-0000-0000-0000000007a1');
select pg_temp.assert_error(
  format($q$select public.approve_publish_request(%L, 1, %L)$q$, :'req_agent', :'dest_x'),
  '42501', 'the agent cannot approve its own proposal, even in the owner''s session');
select pg_temp.assert_error(
  format($q$select public.reject_publish_request(%L)$q$, :'req_agent'),
  '42501', 'the agent cannot reject either');
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000007a1');
select pg_temp.assert(
  (select status = 'published' from public.approve_publish_request(:'req_agent', 1, :'dest_x')),
  'the owner approves the agent proposal as a separate human action');
select pg_temp.reset_actor();
