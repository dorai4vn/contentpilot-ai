-- Tests for M4.1: publish requests, human approval and the publish guard.
-- Same approach as the other files: SET ROLE + JWT claims, any failed assertion aborts.

\set ON_ERROR_STOP on

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.headers', '', false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

-- Same user, but the request carries the AI agent marker header (as PostgREST would expose it).
create or replace function pg_temp.act_as_agent_of(p_user uuid) returns void language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform set_config('request.headers', '{"x-contentpilot-actor":"agent"}', false);
end $$;

create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.headers', '', false);
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  execute 'set role anon';
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

-- Pending request of a post (superuser view, for test bookkeeping).
create or replace function pg_temp.pending_request(p_post uuid) returns uuid language sql as $$
  select id from public.content_publish_requests where post_id = p_post and status = 'pending';
$$;

-- Moves a request 8 days into the past (superuser only; bypasses the request triggers).
create or replace function pg_temp.backdate(p_request uuid) returns void language plpgsql as $$
begin
  set session_replication_role = replica;
  update public.content_publish_requests
     set requested_at = requested_at - interval '8 days', expires_at = expires_at - interval '8 days'
   where id = p_request;
  set session_replication_role = origin;
end $$;

-- Fixtures ---------------------------------------------------------------------
--   d1 Olivia: owner of WC   d2 Adam: admin of WC   d3 Mia: member of WC   d5 Noah: member of WC
--   d4 Otto: owner of WD (outsider to WC)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'olivia@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'adam@example.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'mia@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'otto@example.test'),
  ('00000000-0000-0000-0000-0000000000d5', 'noah@example.test');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
insert into public.workspaces (id, name) values ('dc000000-0000-0000-0000-0000000000c0', 'WC');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('dc000000-0000-0000-0000-0000000000c0', '00000000-0000-0000-0000-0000000000d2', 'admin'),
  ('dc000000-0000-0000-0000-0000000000c0', '00000000-0000-0000-0000-0000000000d3', 'member'),
  ('dc000000-0000-0000-0000-0000000000c0', '00000000-0000-0000-0000-0000000000d5', 'member');
insert into public.content_projects (id, workspace_id, name)
  values ('dc100000-0000-0000-0000-000000000001', 'dc000000-0000-0000-0000-0000000000c0', 'WC blog');
insert into public.content_posts (id, workspace_id, project_id, title, body)
select ('dc200000-0000-0000-0000-00000000000' || n)::uuid, 'dc000000-0000-0000-0000-0000000000c0',
       'dc100000-0000-0000-0000-000000000001', 'Post ' || n, 'Body ' || n
from generate_series(1, 9) n;
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d4');
insert into public.workspaces (id, name) values ('dd000000-0000-0000-0000-0000000000d0', 'WD');
insert into public.content_projects (id, workspace_id, name)
  values ('dd100000-0000-0000-0000-000000000001', 'dd000000-0000-0000-0000-0000000000d0', 'WD blog');
insert into public.content_posts (id, workspace_id, project_id, title)
  values ('dd200000-0000-0000-0000-000000000001', 'dd000000-0000-0000-0000-0000000000d0',
          'dd100000-0000-0000-0000-000000000001', 'WD post');
select public.request_post_publish('dd200000-0000-0000-0000-000000000001', 1);
select pg_temp.reset_actor();

-- 1. Privileges, RLS and structure ----------------------------------------------------
select pg_temp.assert(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.content_publish_requests'::regclass, 'public.content_publish_request_events'::regclass)),
  'RLS is enabled on both approval tables');
select pg_temp.assert(
  has_table_privilege('authenticated', 'public.content_publish_requests', 'SELECT')
  and has_table_privilege('authenticated', 'public.content_publish_request_events', 'SELECT')
  and not has_any_column_privilege('authenticated', 'public.content_publish_requests', 'INSERT')
  and not has_any_column_privilege('authenticated', 'public.content_publish_requests', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.content_publish_requests', 'DELETE')
  and not has_any_column_privilege('authenticated', 'public.content_publish_request_events', 'INSERT')
  and not has_any_column_privilege('authenticated', 'public.content_publish_request_events', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.content_publish_request_events', 'DELETE'),
  'authenticated may only SELECT requests and events');
select pg_temp.assert(
  not has_any_column_privilege('anon', 'public.content_publish_requests', 'SELECT')
  and not has_any_column_privilege('anon', 'public.content_publish_requests', 'INSERT')
  and not has_any_column_privilege('anon', 'public.content_publish_request_events', 'SELECT')
  and not has_any_column_privilege('anon', 'public.content_publish_request_events', 'INSERT'),
  'anon has no privilege on approval tables');
select pg_temp.assert(
  not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('content_posts_guard_publish', 'content_publish_requests_before_insert',
                        'content_publish_requests_guard_update', 'publish_request_record_event',
                        'content_publish_request_events_append_only',
                        'content_posts_cancel_stale_publish_requests', 'publish_caller_is_agent')
      and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'))),
  'internal and trigger functions cannot be called by API roles');
select pg_temp.assert(
  not has_function_privilege('anon', 'public.approve_publish_request(uuid, integer, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.request_post_publish(uuid, integer, public.content_change_source, uuid, text, uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.approve_publish_request(uuid, integer, uuid)', 'EXECUTE'),
  'only signed-in users can call the approval RPCs');
select pg_temp.assert(
  not exists (select 1 from pg_constraint
               where conname in ('content_posts_publishing_disabled', 'content_post_versions_publishing_disabled')),
  'the M2 publishing-disabled CHECKs were replaced');

-- 2. Direct writes are locked (incl. INSERT with status = published) ------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title, status)
     values ('dc000000-0000-0000-0000-0000000000c0', 'dc100000-0000-0000-0000-000000000001', 'Live', 'published')$q$,
  '42501', 'owner cannot INSERT a post as published (CHECK is gone, guard trigger blocks it)');
select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title, status, published_at)
     values ('dc000000-0000-0000-0000-0000000000c0', 'dc100000-0000-0000-0000-000000000001', 'Live', 'published', now())$q$,
  '42501', 'owner cannot INSERT a published post with published_at (column not granted)');
select pg_temp.assert_error(
  $q$update public.content_posts set status = 'published' where id = 'dc200000-0000-0000-0000-000000000001'$q$,
  '42501', 'owner cannot UPDATE a post to published directly (no UPDATE privilege)');
select pg_temp.assert_error(
  $q$select public.update_content_post('dc200000-0000-0000-0000-000000000001', 1, 'Post 1', 'Body 1', 'published', null)$q$,
  '42501', 'owner cannot publish through update_content_post');
select pg_temp.assert_error(
  $q$insert into public.content_publish_requests (workspace_id, post_id, post_version, request_source, expires_at)
     values ('dc000000-0000-0000-0000-0000000000c0', 'dc200000-0000-0000-0000-000000000001', 1, 'user', now())$q$,
  '42501', 'owner cannot INSERT a publish request directly');
select pg_temp.assert_error(
  $q$insert into public.content_publish_request_events (workspace_id, request_id, post_id, post_version, event)
     values ('dc000000-0000-0000-0000-0000000000c0', gen_random_uuid(), 'dc200000-0000-0000-0000-000000000001', 1, 'approved')$q$,
  '42501', 'owner cannot INSERT an audit event directly');
select pg_temp.reset_actor();

select pg_temp.act_as_anon();
select pg_temp.assert_error(
  $q$select public.request_post_publish('dc200000-0000-0000-0000-000000000001', 1)$q$,
  '42501', 'anon cannot request publishing');
select pg_temp.assert_error(
  $q$select count(*) from public.content_publish_requests$q$,
  '42501', 'anon cannot read publish requests');
select pg_temp.reset_actor();

-- 3. Creating requests -----------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d3');
select pg_temp.assert(
  (select r.status = 'pending' and r.post_version = 1 and r.request_source = 'user'
          and r.requested_by = '00000000-0000-0000-0000-0000000000d3'
          and r.expires_at = r.requested_at + interval '7 days'
          and r.decided_by is null and r.decided_at is null
     from public.request_post_publish('dc200000-0000-0000-0000-000000000001', 1, 'user', null, '  Sẵn sàng  ') r),
  'member requests publishing of post 1 v1: pending, requester and 7-day expiry set by the database');
select pg_temp.assert(
  (select reason = 'Sẵn sàng' from public.content_publish_requests where post_id = 'dc200000-0000-0000-0000-000000000001'),
  'reason is trimmed');
select pg_temp.assert_error(
  $q$select public.request_post_publish('dc200000-0000-0000-0000-000000000001', 1)$q$,
  'CP412', 'a second pending request for the same post is rejected');
select pg_temp.assert_error(
  $q$select public.request_post_publish('dc200000-0000-0000-0000-000000000002', 5)$q$,
  'CP409', 'request with a stale expected version is rejected');
select pg_temp.assert_error(
  $q$select public.request_post_publish('dc200000-0000-0000-0000-000000000002', 1, 'agent', null)$q$,
  '22023', 'agent request without a turn id is rejected');
select pg_temp.assert_error(
  $q$select public.request_post_publish('dc200000-0000-0000-0000-000000000002', 1, 'user', gen_random_uuid())$q$,
  '22023', 'user request with a turn id is rejected');
select pg_temp.assert_error(
  $q$select public.request_post_publish('dc200000-0000-0000-0000-000000000002', 1, 'user', null, repeat('x', 501))$q$,
  '22023', 'reason longer than 500 characters is rejected');
select pg_temp.assert_error(
  $q$select public.request_post_publish('dd200000-0000-0000-0000-000000000001', 1)$q$,
  'CP404', 'member cannot request publishing of a post in another workspace');
select pg_temp.reset_actor();

-- The AI agent (acting for Mia) may only create agent-marked requests.
select pg_temp.act_as_agent_of('00000000-0000-0000-0000-0000000000d3');
select pg_temp.assert_error(
  $q$select public.request_post_publish('dc200000-0000-0000-0000-000000000002', 1, 'user', null)$q$,
  '42501', 'agent cannot disguise its request as a user request');
select pg_temp.assert(
  (select r.status = 'pending' and r.request_source = 'agent' and r.agent_turn_id = 'dc900000-0000-0000-0000-000000000001'
          and r.requested_by = '00000000-0000-0000-0000-0000000000d3'
     from public.request_post_publish('dc200000-0000-0000-0000-000000000002', 1, 'agent',
                                      'dc900000-0000-0000-0000-000000000001', 'Bài đã hoàn chỉnh',
                                      -- M4.6a: the agent must name the destination explicitly.
                                      (select id from public.publishing_destinations
                                        where workspace_id = 'dc000000-0000-0000-0000-0000000000c0' and kind = 'internal')) r),
  'agent creates a pending, agent-marked request for post 2');
select pg_temp.reset_actor();

-- 4. Who may approve -------------------------------------------------------------------
select pg_temp.pending_request('dc200000-0000-0000-0000-000000000001') as r1,
       pg_temp.pending_request('dc200000-0000-0000-0000-000000000002') as r2,
       pg_temp.pending_request('dd200000-0000-0000-0000-000000000001') as rwd \gset

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d3');
select pg_temp.assert_error(format($q$select public.approve_publish_request(%L, 1)$q$, :'r1'),
  '42501', 'a member cannot approve (even their own request)');
select pg_temp.assert_error(format($q$select public.reject_publish_request(%L)$q$, :'r1'),
  '42501', 'a member cannot reject');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d4');
select pg_temp.assert_error(format($q$select public.approve_publish_request(%L, 1)$q$, :'r1'),
  'CP404', 'an owner of another workspace cannot approve (request is invisible)');
select pg_temp.assert(
  (select count(*) = 0 from public.content_publish_requests where workspace_id = 'dc000000-0000-0000-0000-0000000000c0')
  and (select count(*) = 0 from public.content_publish_request_events where workspace_id = 'dc000000-0000-0000-0000-0000000000c0'),
  'an outsider sees no requests or audit events of the workspace');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select pg_temp.assert_error(format($q$select public.approve_publish_request(%L, 1)$q$, :'rwd'),
  'CP404', 'owner of WC cannot approve a request of WD');
select pg_temp.reset_actor();

-- The agent cannot approve or reject, even with an owner's session.
select pg_temp.act_as_agent_of('00000000-0000-0000-0000-0000000000d1');
select pg_temp.assert_error(format($q$select public.approve_publish_request(%L, 1)$q$, :'r2'),
  '42501', 'the AI agent cannot approve, even in an owner session');
select pg_temp.assert_error(format($q$select public.reject_publish_request(%L)$q$, :'r2'),
  '42501', 'the AI agent cannot reject, even in an owner session');
select pg_temp.reset_actor();

-- 5. Explicit approval by an owner publishes exactly the requested version --------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select pg_temp.assert_error(format($q$select public.approve_publish_request(%L, 2)$q$, :'r1'),
  'CP409', 'approval with a different post version than requested is rejected');
select pg_temp.assert(
  (select p.status = 'published' and p.published_at is not null and p.version = 2
          and p.last_change_source = 'user' and p.updated_by = '00000000-0000-0000-0000-0000000000d1'
          and p.title = 'Post 1' and p.body = 'Body 1'
     from public.approve_publish_request(:'r1', 1) p),
  'owner approves the member request: post 1 is published (v2, same content)');
select pg_temp.assert(
  (select r.status = 'approved' and r.decided_by = '00000000-0000-0000-0000-0000000000d1'
          and r.decided_at > r.requested_at and r.cancel_reason is null
     from public.content_publish_requests r where r.id = :'r1'),
  'request is approved; approver and time set by the database');
select pg_temp.assert(
  (select array_agg(e.event::text || ':' || e.post_version || ':' || coalesce(e.actor_source::text, '-') order by e.created_at, e.event)
     from public.content_publish_request_events e where e.request_id = :'r1')
  = array['requested:1:user', 'approved:1:user', 'published:2:user'],
  'audit trail: requested -> approved -> published');
select pg_temp.assert(
  (select v.status = 'published' and v.change_source = 'user' and v.changed_by = '00000000-0000-0000-0000-0000000000d1'
     from public.content_post_versions v where v.post_id = 'dc200000-0000-0000-0000-000000000001' and v.version = 2),
  'the published version is recorded in the post history');

-- Replays and changes after publication.
select pg_temp.assert_error(format($q$select public.approve_publish_request(%L, 1)$q$, :'r1'),
  'CP410', 'approving the same request again is rejected');
select pg_temp.assert_error(format($q$select public.reject_publish_request(%L)$q$, :'r1'),
  'CP410', 'rejecting an approved request is rejected');
select pg_temp.assert_error(format($q$select public.cancel_publish_request(%L)$q$, :'r1'),
  'CP410', 'cancelling an approved request is rejected');
select pg_temp.assert_error(
  $q$select public.update_content_post('dc200000-0000-0000-0000-000000000001', 2, 'Changed', 'Body 1', 'published', null)$q$,
  '42501', 'update_content_post still refuses status published');
select pg_temp.assert_error(
  $q$select public.update_content_post('dc200000-0000-0000-0000-000000000001', 2, 'Changed', 'Body 1', 'draft', null)$q$,
  'CP422', 'a published post cannot be edited or unpublished');
select pg_temp.assert_error(
  $q$select public.archive_content_post('dc200000-0000-0000-0000-000000000001', 2)$q$,
  'CP422', 'a published post cannot be archived');
select pg_temp.assert_error(
  $q$select public.request_post_publish('dc200000-0000-0000-0000-000000000001', 2)$q$,
  'CP422', 'a published post cannot be requested again');

-- The owner also approves the agent's request (human decision on an agent proposal).
select pg_temp.assert(
  (select p.status = 'published' from public.approve_publish_request(:'r2', 1) p),
  'owner approves the agent request for post 2');
select pg_temp.assert(
  (select e.actor_source = 'agent' and e.actor_id = '00000000-0000-0000-0000-0000000000d3'
     from public.content_publish_request_events e where e.request_id = :'r2' and e.event = 'requested')
  and (select e.actor_source = 'user' and e.actor_id = '00000000-0000-0000-0000-0000000000d1'
     from public.content_publish_request_events e where e.request_id = :'r2' and e.event = 'approved'),
  'audit trail records the agent as requester and the owner as approver');
select pg_temp.reset_actor();

-- 6. Self-approval by an admin: allowed, but only as a separate, explicit action --------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d2');
select public.request_post_publish('dc200000-0000-0000-0000-000000000003', 1);
select pg_temp.pending_request('dc200000-0000-0000-0000-000000000003') as r3 \gset
select pg_temp.assert(
  (select p.status = 'published' from public.approve_publish_request(:'r3', 1) p),
  'admin approves their own request in a separate call');
select pg_temp.assert(
  (select r.requested_by = r.decided_by and r.decided_at > r.requested_at
     from public.content_publish_requests r where r.id = :'r3'),
  'self-approval is recorded with requester = approver');
select pg_temp.assert_error(
  $q$do $d$
     declare v_id uuid;
     begin
       select id into v_id from public.request_post_publish('dc200000-0000-0000-0000-000000000004', 1);
       perform public.approve_publish_request(v_id, 1);
     end $d$$q$,
  '42501', 'request and approval in the same transaction are rejected (no implicit approval)');
select pg_temp.assert(
  (select pg_temp.pending_request('dc200000-0000-0000-0000-000000000004') is null),
  'nothing remains of the rolled-back attempt');
select pg_temp.reset_actor();

-- 7. A changed post invalidates its pending request -----------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d3');
select public.request_post_publish('dc200000-0000-0000-0000-000000000004', 1);
select pg_temp.pending_request('dc200000-0000-0000-0000-000000000004') as r4 \gset
select public.request_post_publish('dc200000-0000-0000-0000-000000000005', 1);
select pg_temp.pending_request('dc200000-0000-0000-0000-000000000005') as r5 \gset
-- Mia edits post 4 after asking for approval.
select public.update_content_post('dc200000-0000-0000-0000-000000000004', 1, 'Post 4', 'Edited body', 'draft', null);
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select pg_temp.assert(
  (select r.status = 'cancelled' and r.cancel_reason = 'post_changed' and r.decided_by = '00000000-0000-0000-0000-0000000000d3'
     from public.content_publish_requests r where r.id = :'r4'),
  'editing the post cancels its pending request (post_changed)');
select pg_temp.assert(
  (select e.cancel_reason = 'post_changed' and e.actor_source = 'user'
     from public.content_publish_request_events e where e.request_id = :'r4' and e.event = 'cancelled'),
  'the cancellation is in the audit trail');
select pg_temp.assert_error(format($q$select public.approve_publish_request(%L, 1)$q$, :'r4'),
  'CP410', 'the changed version cannot be approved with the old request');
select pg_temp.assert_error(format($q$select public.approve_publish_request(%L, 2)$q$, :'r4'),
  'CP410', 'nor with the new version number');
select pg_temp.assert(
  (select status = 'draft' and version = 2 from public.content_posts where id = 'dc200000-0000-0000-0000-000000000004'),
  'post 4 stays an unpublished draft');
-- Archiving also changes the post.
select public.archive_content_post('dc200000-0000-0000-0000-000000000005', 1);
select pg_temp.assert(
  (select status = 'cancelled' and cancel_reason = 'post_changed' from public.content_publish_requests where id = :'r5'),
  'archiving the post cancels its pending request');
select pg_temp.assert_error(
  $q$select public.request_post_publish('dc200000-0000-0000-0000-000000000005', 2)$q$,
  'CP423', 'an archived post cannot be requested');
select pg_temp.reset_actor();

-- 8. Expiry (7 days) ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d3');
select public.request_post_publish('dc200000-0000-0000-0000-000000000006', 1);
select pg_temp.reset_actor();
select pg_temp.pending_request('dc200000-0000-0000-0000-000000000006') as r6 \gset
select pg_temp.backdate(:'r6');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select pg_temp.assert_error(format($q$select public.approve_publish_request(%L, 1)$q$, :'r6'),
  'CP410', 'an expired request cannot be approved');
select pg_temp.assert_error(format($q$select public.reject_publish_request(%L)$q$, :'r6'),
  'CP410', 'an expired request cannot be rejected');
select pg_temp.assert(
  (select status = 'draft' from public.content_posts where id = 'dc200000-0000-0000-0000-000000000006'),
  'post 6 stays a draft');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d3');
select pg_temp.assert(
  (select r.status = 'pending' and r.id <> :'r6'
     from public.request_post_publish('dc200000-0000-0000-0000-000000000006', 1) r),
  'a new request replaces the expired one');
select pg_temp.assert(
  (select status = 'cancelled' and cancel_reason = 'expired' from public.content_publish_requests where id = :'r6'),
  'the expired request is closed as expired');
select pg_temp.reset_actor();

-- 9. Rejection and cancellation ------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d3');
select public.request_post_publish('dc200000-0000-0000-0000-000000000007', 1);
select pg_temp.pending_request('dc200000-0000-0000-0000-000000000007') as r7 \gset
select public.request_post_publish('dc200000-0000-0000-0000-000000000008', 1);
select pg_temp.pending_request('dc200000-0000-0000-0000-000000000008') as r8 \gset
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d2');
select pg_temp.assert_error(format($q$select public.reject_publish_request(%L, %L)$q$, :'r7', repeat('x', 501)),
  '22023', 'a rejection note longer than 500 characters is rejected');
select pg_temp.assert(
  (select r.status = 'rejected' and r.decision_note = 'Cần sửa tiêu đề' and r.decided_by = '00000000-0000-0000-0000-0000000000d2'
     from public.reject_publish_request(:'r7', ' Cần sửa tiêu đề ') r),
  'admin rejects with a note');
select pg_temp.assert_error(format($q$select public.approve_publish_request(%L, 1)$q$, :'r7'),
  'CP410', 'a rejected request cannot be approved afterwards');
select pg_temp.assert(
  (select status = 'draft' and version = 1 from public.content_posts where id = 'dc200000-0000-0000-0000-000000000007'),
  'rejection does not change the post');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d5');
select pg_temp.assert_error(format($q$select public.cancel_publish_request(%L)$q$, :'r8'),
  '42501', 'another member cannot cancel someone else''s request');
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d3');
select pg_temp.assert(
  (select status = 'cancelled' and cancel_reason = 'withdrawn' from public.cancel_publish_request(:'r8')),
  'the requester withdraws their request');
select pg_temp.assert_error(format($q$select public.cancel_publish_request(%L)$q$, :'r8'),
  'CP410', 'cancelling twice is rejected');
select pg_temp.reset_actor();

-- 10. Bypass attempts, even with superuser rights -----------------------------------------------
-- Superuser with Olivia's claims fakes an approval in one transaction, then publishes in another.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d3');
select public.request_post_publish('dc200000-0000-0000-0000-000000000009', 1);
select pg_temp.reset_actor();
select pg_temp.pending_request('dc200000-0000-0000-0000-000000000009') as r9 \gset
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', false);
update public.content_publish_requests set status = 'approved' where id = :'r9';
select pg_temp.assert_error(
  $q$update public.content_posts set status = 'published' where id = 'dc200000-0000-0000-0000-000000000009'$q$,
  '42501', 'an approval from an earlier transaction does not unlock publishing (decided_at must be now())');
select pg_temp.assert_error(
  $q$update public.content_posts set status = 'published', body = 'Other content' where id = 'dc200000-0000-0000-0000-000000000009'$q$,
  '42501', 'publishing cannot change the content at the same time');
select pg_temp.assert_error(
  format($q$update public.content_publish_requests set status = 'pending' where id = %L$q$, :'r9'),
  'CP410', 'a decision cannot be reverted, even by the superuser');
select pg_temp.assert_error(
  format($q$update public.content_publish_requests set decided_by = '00000000-0000-0000-0000-0000000000d2' where id = %L$q$, :'r9'),
  'CP410', 'the approver cannot be forged, even by the superuser');
select pg_temp.assert_error(
  format($q$update public.content_publish_requests set post_version = 9 where id = %L$q$, :'r9'),
  '42501', 'the requested version cannot be changed');
select pg_temp.assert_error(
  format($q$delete from public.content_publish_requests where id = %L$q$, :'r9'),
  '42501', 'publish requests cannot be deleted, even by the superuser');
select pg_temp.assert_error(
  format($q$update public.content_publish_request_events set event = 'rejected' where request_id = %L$q$, :'r1'),
  '42501', 'audit events cannot be changed');
select pg_temp.assert_error(
  format($q$delete from public.content_publish_request_events where request_id = %L$q$, :'r1'),
  '42501', 'audit events cannot be deleted');
select set_config('request.jwt.claims', '', false);
select pg_temp.assert_error(
  $q$update public.content_posts set status = 'published' where id = 'dc200000-0000-0000-0000-000000000006'$q$,
  '42501', 'superuser cannot publish without an approved request');
select pg_temp.assert_error(
  $q$update public.content_posts set published_at = now() where id = 'dc200000-0000-0000-0000-000000000006'$q$,
  '23514', 'published_at without status published is rejected (consistency CHECK)');

-- Malformed agent header fails closed.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select set_config('request.headers', 'not json', false);
select pg_temp.assert_error(
  $q$select public.reject_publish_request('dc200000-0000-0000-0000-000000000000')$q$,
  '22P02', 'a malformed request header makes approval RPCs fail closed');
select pg_temp.reset_actor();

-- 11. Overall state --------------------------------------------------------------------------------
select pg_temp.assert(
  (select array_agg(id::text order by id) from public.content_posts
    where status = 'published' and workspace_id = 'dc000000-0000-0000-0000-0000000000c0')
  = array['dc200000-0000-0000-0000-000000000001', 'dc200000-0000-0000-0000-000000000002',
          'dc200000-0000-0000-0000-000000000003'],
  'exactly the three explicitly approved posts are published');
select pg_temp.assert(
  (select bool_and(exists (
     select 1 from public.content_publish_request_events e
      where e.post_id = p.id and e.event = 'published'))
     from public.content_posts p where p.status = 'published'),
  'every published post has a published audit event');
select pg_temp.assert(
  (select count(*) = 0 from public.content_publish_requests r
    join public.content_posts p on p.id = r.post_id
   where r.workspace_id <> p.workspace_id),
  'every request is in the workspace of its post');

-- 12. Deleting an account keeps the approval history (user ids become null) --------------------
-- Adam requested and approved post 3 (published) and rejected request r7.
delete from auth.users where id = '00000000-0000-0000-0000-0000000000d2';
select pg_temp.assert(
  (select requested_by is null and decided_by is null and status = 'approved' from public.content_publish_requests where id = :'r3')
  and (select decided_by is null and status = 'rejected' and decision_note = 'Cần sửa tiêu đề'
         from public.content_publish_requests where id = :'r7'),
  'requests survive account deletion with user ids cleared and decisions unchanged');
select pg_temp.assert(
  (select count(*) = 3 and bool_and(actor_id is null) from public.content_publish_request_events where request_id = :'r3'),
  'audit events survive account deletion with actor_id cleared');
select pg_temp.assert(
  (select status = 'published' and updated_by is null and version = 2
     from public.content_posts where id = 'dc200000-0000-0000-0000-000000000003'),
  'the published post keeps its state (only bookkeeping cleared, no new version)');
