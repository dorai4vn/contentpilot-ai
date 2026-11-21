-- Tests for M4.6a: publishing destinations, destination-scoped approval and deliveries.
-- Pre-migration data comes from tests/db/hooks/before_20261121120000_publishing_destinations.sql.

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
create or replace function pg_temp.affected(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
create or replace function pg_temp.internal_of(p_ws uuid) returns uuid language sql as $$
  select id from public.publishing_destinations where workspace_id = p_ws and kind = 'internal';
$$;
create or replace function pg_temp.request_of(p_post uuid, p_status text default 'pending') returns uuid language sql as $$
  select id from public.content_publish_requests where post_id = p_post and status::text = p_status
  order by requested_at desc limit 1;
$$;

-- 1. Backfill of data created before the migration (M4 era) ---------------------------------------
select pg_temp.assert(
  (select count(*) = 1 from public.publishing_destinations
    where workspace_id = '6b000000-0000-0000-0000-000000000001' and kind = 'internal' and name = 'Nội bộ' and status = 'active')
  and (select count(*) = 1 from public.publishing_destinations
    where workspace_id = '6b000000-0000-0000-0000-000000000002' and kind = 'internal'),
  'backfill: every pre-existing workspace (with or without content) has exactly one internal destination');
select pg_temp.assert(
  not exists (select 1 from public.workspaces w where not exists (
    select 1 from public.publishing_destinations d where d.workspace_id = w.id and d.kind = 'internal')),
  'every workspace in the database has an internal destination');
select pg_temp.assert(
  (select bool_and(r.destination_id = pg_temp.internal_of(r.workspace_id)) from public.content_publish_requests r
    where r.workspace_id = '6b000000-0000-0000-0000-000000000001')
  and not exists (select 1 from public.content_publish_requests where destination_id is null),
  'backfill: every pre-existing request now targets its workspace''s internal destination');
select pg_temp.assert(
  (select status = 'published' and version = 2 from public.content_posts where id = '6b200000-0000-0000-0000-000000000001'),
  'the legacy published post is unchanged');
select pg_temp.assert(
  (select count(*) = 3 from public.content_publish_request_events
    where post_id = '6b200000-0000-0000-0000-000000000001')
  and (select count(*) = 1 from public.content_publish_request_events
    where post_id = '6b200000-0000-0000-0000-000000000002'),
  'backfill added no audit events and kept the old ones');
select pg_temp.assert(
  not exists (select 1 from public.publish_deliveries where post_id = '6b200000-0000-0000-0000-000000000001'),
  'no delivery is invented for approvals made before the migration');

-- The legacy pending request can still be approved with the M4 call (no destination).
select pg_temp.act_as('00000000-0000-0000-0000-0000000006b1');
select pg_temp.assert(
  (select p.status = 'published' from public.approve_publish_request(
     pg_temp.request_of('6b200000-0000-0000-0000-000000000002'), 1) p),
  'a legacy pending request is approved with the old 2-argument call');
select pg_temp.reset_actor();
select pg_temp.assert(
  (select d.status = 'succeeded' and d.attempt_count = 1 and d.completed_at is not null
          and d.destination_id = pg_temp.internal_of('6b000000-0000-0000-0000-000000000001')
          and d.idempotency_key = 'request:' || d.request_id
     from public.publish_deliveries d where d.post_id = '6b200000-0000-0000-0000-000000000002'),
  'approving internally records a succeeded delivery for the internal destination');

-- 2. Structure and privileges -----------------------------------------------------------------------
select pg_temp.assert(
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.publishing_destinations'::regclass, 'public.publish_deliveries'::regclass)),
  'RLS is enabled on destinations and deliveries');
select pg_temp.assert(
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name in ('publishing_destinations', 'publish_deliveries')
                 and column_name ~* '(token|secret|credential|password|api_key|access)'),
  'no credential-like column in destinations or deliveries');
select pg_temp.assert(
  has_table_privilege('authenticated', 'public.publishing_destinations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.publishing_destinations', 'DELETE')
  and not has_column_privilege('authenticated', 'public.publishing_destinations', 'created_by', 'INSERT')
  and not has_column_privilege('authenticated', 'public.publishing_destinations', 'workspace_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.publishing_destinations', 'kind', 'UPDATE')
  and has_table_privilege('authenticated', 'public.publish_deliveries', 'SELECT')
  and not has_any_column_privilege('authenticated', 'public.publish_deliveries', 'INSERT')
  and not has_any_column_privilege('authenticated', 'public.publish_deliveries', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.publish_deliveries', 'DELETE'),
  'authenticated: manage destinations by column, read-only deliveries');
select pg_temp.assert(
  not has_any_column_privilege('anon', 'public.publishing_destinations', 'SELECT')
  and not has_any_column_privilege('anon', 'public.publish_deliveries', 'SELECT')
  and not has_function_privilege('anon', 'public.approve_publish_request(uuid, integer, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.request_post_publish(uuid, integer, public.content_change_source, uuid, text, uuid)', 'EXECUTE'),
  'anon has no access');
select pg_temp.assert(
  not has_function_privilege('authenticated', 'public.create_internal_publishing_destination()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.publish_deliveries_guard()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.publishing_destinations_before_write()', 'EXECUTE'),
  'trigger functions are not callable by clients');
select pg_temp.assert(
  not exists (select 1 from pg_proc where proname = 'request_post_publish' and pronargs = 5)
  and not exists (select 1 from pg_proc where proname = 'approve_publish_request' and pronargs = 2),
  'the old RPC signatures were replaced (no ambiguous overloads)');

-- 3. New workspaces, isolation, destination management ------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000006c1', 'dest-owner@example.test'),
  ('00000000-0000-0000-0000-0000000006c2', 'dest-admin@example.test'),
  ('00000000-0000-0000-0000-0000000006c3', 'dest-member@example.test'),
  ('00000000-0000-0000-0000-0000000006c4', 'dest-outsider@example.test');

select pg_temp.act_as('00000000-0000-0000-0000-0000000006c1');
insert into public.workspaces (id, name) values ('6c000000-0000-0000-0000-000000000001', 'Dest WS');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('6c000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000006c2', 'admin'),
  ('6c000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000006c3', 'member');
insert into public.content_projects (id, workspace_id, name)
  values ('6c100000-0000-0000-0000-000000000001', '6c000000-0000-0000-0000-000000000001', 'Blog');
insert into public.content_posts (id, workspace_id, project_id, title)
select ('6c200000-0000-0000-0000-00000000000' || n)::uuid, '6c000000-0000-0000-0000-000000000001',
       '6c100000-0000-0000-0000-000000000001', 'Post ' || n
from generate_series(1, 8) n;
select pg_temp.assert(
  (select count(*) = 1 and bool_and(kind = 'internal' and status = 'active' and created_by = '00000000-0000-0000-0000-0000000006c1')
     from public.publishing_destinations where workspace_id = '6c000000-0000-0000-0000-000000000001'),
  'a new workspace gets its internal destination automatically');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000006c4');
insert into public.workspaces (id, name) values ('6c000000-0000-0000-0000-000000000009', 'Outsider WS');
select pg_temp.assert(
  (select array_agg(workspace_id::text) from public.publishing_destinations) = array['6c000000-0000-0000-0000-000000000009'],
  'an outsider sees only the destinations of their own workspace');
select pg_temp.assert(
  (select count(*) = 0 from public.publish_deliveries),
  'an outsider sees no deliveries of other workspaces');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000006c3');
select pg_temp.assert(
  (select count(*) = 1 from public.publishing_destinations where workspace_id = '6c000000-0000-0000-0000-000000000001'),
  'a member reads the destinations of their workspace');
select pg_temp.assert_error(
  $q$insert into public.publishing_destinations (workspace_id, kind, name) values ('6c000000-0000-0000-0000-000000000001', 'internal', 'X')$q$,
  '42501', 'a member cannot add destinations');
select pg_temp.assert(
  pg_temp.affected($q$update public.publishing_destinations set name = 'Đổi tên' where workspace_id = '6c000000-0000-0000-0000-000000000001'$q$) = 0,
  'a member cannot rename destinations (0 rows)');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000006c2');
select pg_temp.assert_error(
  $q$insert into public.publishing_destinations (workspace_id, kind, name) values ('6c000000-0000-0000-0000-000000000001', 'internal', 'Nội bộ 2')$q$,
  '23505', 'a second internal destination is impossible');
select pg_temp.assert_error(
  $q$insert into public.publishing_destinations (workspace_id, kind, name, target_ref) values ('6c000000-0000-0000-0000-000000000001', 'telegram', 'Telegram', '@channel')$q$,
  '23514', 'external kinds are not enabled yet (CHECK)');
select pg_temp.assert_error(
  $q$insert into public.publishing_destinations (workspace_id, kind, name) values ('6c000000-0000-0000-0000-000000000009', 'internal', 'X')$q$,
  '42501', 'an admin cannot add destinations to another workspace');
select pg_temp.assert(
  pg_temp.affected($q$update public.publishing_destinations set name = 'Trang nội bộ' where workspace_id = '6c000000-0000-0000-0000-000000000001'$q$) = 1,
  'an admin renames the internal destination');
select pg_temp.assert_error(
  $q$update public.publishing_destinations set status = 'disabled' where workspace_id = '6c000000-0000-0000-0000-000000000001'$q$,
  '42501', 'the internal destination cannot be disabled');
select pg_temp.assert_error(
  $q$update public.publishing_destinations set target_ref = 'x' where workspace_id = '6c000000-0000-0000-0000-000000000001'$q$,
  '42501', 'the internal destination cannot get a target');
select pg_temp.assert_error(
  $q$delete from public.publishing_destinations where workspace_id = '6c000000-0000-0000-0000-000000000001'$q$,
  '42501', 'destinations cannot be deleted');
select pg_temp.reset_actor();
select pg_temp.assert_error(
  $q$update public.publishing_destinations set workspace_id = '6c000000-0000-0000-0000-000000000009' where workspace_id = '6c000000-0000-0000-0000-000000000001'$q$,
  '42501', 'a destination cannot move to another workspace (even for the superuser)');
select pg_temp.assert_error(
  $q$update public.publishing_destinations set kind = 'internal', created_at = now() - interval '1 day' where workspace_id = '6c000000-0000-0000-0000-000000000001'$q$,
  '42501', 'destination identity is immutable');

-- Destination ids, read here as superuser: under RLS a user cannot even see the
-- other workspace's destination (internal_of() would return NULL for them).
select pg_temp.internal_of('6c000000-0000-0000-0000-000000000001') as dest_c,
       pg_temp.internal_of('6c000000-0000-0000-0000-000000000009') as dest_out \gset

-- 4. Requests are scoped to one destination -------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c3');
select pg_temp.assert(
  (select r.destination_id = pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')
     from public.request_post_publish('6c200000-0000-0000-0000-000000000001', 1) r),
  'legacy call without a destination targets the internal destination');
select pg_temp.assert(
  (select r.status = 'pending'
     from public.request_post_publish('6c200000-0000-0000-0000-000000000002', 1, 'user', null, null,
                                      pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')) r),
  'explicit internal destination accepted');
select pg_temp.assert_error(
  format($q$select public.request_post_publish('6c200000-0000-0000-0000-000000000003', 1, 'user', null, null, %L)$q$,
         :'dest_out'),
  'CP404', 'a destination of another workspace is rejected');
select pg_temp.assert_error(
  $q$select public.request_post_publish('6c200000-0000-0000-0000-000000000003', 1, 'user', null, null, gen_random_uuid())$q$,
  'CP404', 'an unknown destination is rejected');
select pg_temp.assert_error(
  $q$select public.request_post_publish('6c200000-0000-0000-0000-000000000003', 1, 'agent', gen_random_uuid(), null, null)$q$,
  '22023', 'agent-source requests must name a destination');
select pg_temp.reset_actor();
select pg_temp.act_as_agent_of('00000000-0000-0000-0000-0000000006c3');
select pg_temp.assert_error(
  $q$select public.request_post_publish('6c200000-0000-0000-0000-000000000003', 1)$q$,
  '42501', 'the agent cannot use the legacy (user, implicit destination) call');
select pg_temp.assert(
  (select r.request_source = 'agent'
     from public.request_post_publish('6c200000-0000-0000-0000-000000000003', 1, 'agent', gen_random_uuid(), null,
                                      pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')) r),
  'the agent files a request for an explicit destination');
select pg_temp.reset_actor();

-- 5. Approval bound to destination and version ------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c1');
select pg_temp.assert_error(
  format($q$select public.approve_publish_request(%L, 1, %L)$q$,
         pg_temp.request_of('6c200000-0000-0000-0000-000000000001'), :'dest_out'),
  'CP409', 'approval with another destination than requested is rejected');
select pg_temp.assert_error(
  format($q$select public.approve_publish_request(%L, 1, gen_random_uuid())$q$, pg_temp.request_of('6c200000-0000-0000-0000-000000000001')),
  'CP409', 'approval with an unknown destination is rejected');
select pg_temp.assert_error(
  format($q$select public.approve_publish_request(%L, 2, %L)$q$,
         pg_temp.request_of('6c200000-0000-0000-0000-000000000001'), pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')),
  'CP409', 'approval with another version than requested is rejected');
select pg_temp.assert(
  (select p.status = 'published' from public.approve_publish_request(
     pg_temp.request_of('6c200000-0000-0000-0000-000000000001'), 1, pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')) p),
  'approval with the reviewed destination and version publishes (internal)');
select pg_temp.assert(
  (select count(*) = 1 from public.publish_deliveries where post_id = '6c200000-0000-0000-0000-000000000001' and status = 'succeeded'),
  'exactly one succeeded delivery');
select pg_temp.reset_actor();

select pg_temp.act_as_agent_of('00000000-0000-0000-0000-0000000006c1');
select pg_temp.assert_error(
  format($q$select public.approve_publish_request(%L, 1, %L)$q$,
         pg_temp.request_of('6c200000-0000-0000-0000-000000000003'), pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')),
  '42501', 'the agent still cannot approve (owner session, agent header)');
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c3');
select pg_temp.assert_error(
  format($q$select public.approve_publish_request(%L, 1)$q$, pg_temp.request_of('6c200000-0000-0000-0000-000000000002')),
  '42501', 'a member still cannot approve');
select pg_temp.reset_actor();

-- 6. Deliveries cannot be forged or altered ------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c1');
select pg_temp.assert_error(
  format($q$insert into public.publish_deliveries (workspace_id, request_id, destination_id, post_id, post_version, status, idempotency_key)
            values ('6c000000-0000-0000-0000-000000000001', %L, %L, '6c200000-0000-0000-0000-000000000002', 1, 'succeeded', 'x')$q$,
         pg_temp.request_of('6c200000-0000-0000-0000-000000000002'), pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')),
  '42501', 'an owner cannot insert a delivery');
select pg_temp.assert_error(
  $q$update public.publish_deliveries set external_post_id = 'fake' where post_id = '6c200000-0000-0000-0000-000000000001'$q$,
  '42501', 'an owner cannot change a delivery');
select pg_temp.assert_error(
  $q$delete from public.publish_deliveries where post_id = '6c200000-0000-0000-0000-000000000001'$q$,
  '42501', 'an owner cannot delete a delivery');
select pg_temp.reset_actor();

-- Even the superuser (bypasses grants and RLS) hits the delivery guard.
select pg_temp.assert_error(
  format($q$insert into public.publish_deliveries (workspace_id, request_id, destination_id, post_id, post_version, status, idempotency_key)
            values ('6c000000-0000-0000-0000-000000000001', %1$L, %2$L, '6c200000-0000-0000-0000-000000000002', 1, 'succeeded', 'request:' || %1$L)$q$,
         pg_temp.request_of('6c200000-0000-0000-0000-000000000002'), pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')),
  '42501', 'no delivery for a request that is not approved');
select pg_temp.assert_error(
  format($q$insert into public.publish_deliveries (workspace_id, request_id, destination_id, post_id, post_version, status, idempotency_key)
            values ('6c000000-0000-0000-0000-000000000001', %1$L, %2$L, '6c200000-0000-0000-0000-000000000001', 2, 'queued', 'request:' || %1$L)$q$,
         pg_temp.request_of('6c200000-0000-0000-0000-000000000001', 'approved'), pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')),
  '42501', 'no delivery for another version than the approved one');
select pg_temp.assert_error(
  format($q$insert into public.publish_deliveries (workspace_id, request_id, destination_id, post_id, post_version, status, idempotency_key)
            values ('6c000000-0000-0000-0000-000000000001', %1$L, %2$L, '6c200000-0000-0000-0000-000000000001', 1, 'queued', 'request:' || %1$L)$q$,
         pg_temp.request_of('6c200000-0000-0000-0000-000000000001', 'approved'), pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')),
  '23505', 'a second delivery for the same approval is impossible (idempotency)');
select pg_temp.assert_error(
  $q$update public.publish_deliveries set status = 'failed', completed_at = now() where post_id = '6c200000-0000-0000-0000-000000000001'$q$,
  '42501', 'a succeeded delivery is final');
select pg_temp.assert_error(
  $q$update public.publish_deliveries set post_version = 9 where post_id = '6c200000-0000-0000-0000-000000000001'$q$,
  '42501', 'delivery identity is immutable');
select pg_temp.assert_error(
  $q$delete from public.publish_deliveries where post_id = '6c200000-0000-0000-0000-000000000001'$q$,
  '42501', 'deliveries cannot be deleted, even by the superuser');
select pg_temp.assert_error(
  $q$update public.content_publish_requests set destination_id = gen_random_uuid() where post_id = '6c200000-0000-0000-0000-000000000002'$q$,
  '42501', 'the destination of a request is immutable');

select pg_temp.act_as('00000000-0000-0000-0000-0000000006c3');
select pg_temp.assert(
  (select count(*) = 1 from public.publish_deliveries where workspace_id = '6c000000-0000-0000-0000-000000000001'),
  'members read the deliveries of their workspace');
select pg_temp.reset_actor();

-- 7. Simulated future destination kind (what an M5 migration would enable) -----------------------------------
-- Enables a test-only external kind in this disposable database to exercise the
-- multi-destination rules that real platforms will rely on.
alter table public.publishing_destinations drop constraint publishing_destinations_kind_check;
alter table public.publishing_destinations add constraint publishing_destinations_kind_check
  check (kind in ('internal', 'test_external'));

select pg_temp.act_as('00000000-0000-0000-0000-0000000006c2');
-- Clients cannot choose the id (not granted); the database generates it.
select pg_temp.assert_error(
  $q$insert into public.publishing_destinations (id, workspace_id, kind, name) values (gen_random_uuid(), '6c000000-0000-0000-0000-000000000001', 'test_external', 'X')$q$,
  '42501', 'clients cannot choose a destination id');
select pg_temp.assert_error(
  $q$insert into public.publishing_destinations (workspace_id, kind, name, created_by) values ('6c000000-0000-0000-0000-000000000001', 'test_external', 'X', '00000000-0000-0000-0000-0000000006c3')$q$,
  '42501', 'clients cannot forge created_by');
insert into public.publishing_destinations (workspace_id, kind, name, target_ref) values
  ('6c000000-0000-0000-0000-000000000001', 'test_external', 'Kênh A', 'channel-a'),
  ('6c000000-0000-0000-0000-000000000001', 'test_external', 'Kênh B', 'channel-b');
select pg_temp.assert(
  (select count(*) = 3 from public.publishing_destinations where workspace_id = '6c000000-0000-0000-0000-000000000001'),
  'several destinations in one workspace (internal + two channels)');
select pg_temp.reset_actor();
select (select id from public.publishing_destinations where name = 'Kênh A') as ext_a,
       (select id from public.publishing_destinations where name = 'Kênh B') as ext_b \gset

select pg_temp.act_as('00000000-0000-0000-0000-0000000006c3');
select public.request_post_publish('6c200000-0000-0000-0000-000000000004', 1, 'user', null, null, :'ext_a');
select pg_temp.assert(
  (select r.status = 'pending' from public.request_post_publish('6c200000-0000-0000-0000-000000000004', 1) r),
  'two pending requests for one post on two different destinations');
select pg_temp.assert_error(
  format($q$select public.request_post_publish('6c200000-0000-0000-0000-000000000004', 1, 'user', null, null, %L)$q$, :'ext_a'),
  'CP412', 'a second pending request for the same post and destination is rejected');
select pg_temp.reset_actor();

-- Approving the external request queues a delivery and publishes NOTHING internally.
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c1');
select pg_temp.assert(
  (select p.status = 'draft' from public.approve_publish_request(
     (select id from public.content_publish_requests where post_id = '6c200000-0000-0000-0000-000000000004'
        and destination_id = :'ext_a'), 1, :'ext_a') p),
  'approving an external destination does not change the post status');
select pg_temp.reset_actor();
select pg_temp.assert(
  (select d.status = 'queued' and d.attempt_count = 0 and d.completed_at is null and d.next_attempt_at is not null
          and d.external_post_id is null
     from public.publish_deliveries d where d.destination_id = :'ext_a'),
  'the external approval created one queued delivery (no API call)');
select pg_temp.assert(
  not exists (select 1 from public.content_publish_request_events e
               join public.content_publish_requests r on r.id = e.request_id
              where r.destination_id = :'ext_a' and e.event = 'published'),
  'no "published" audit event for a queued external delivery');
select pg_temp.assert(
  (select status = 'pending' from public.content_publish_requests
    where post_id = '6c200000-0000-0000-0000-000000000004' and destination_id = pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')),
  'the internal request of the same post is still pending: approval scope does not spread');

-- An external approval can never unlock the internal publish guard: even inside
-- one transaction, with the approver's identity and decided_at = now().
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c3');
select public.request_post_publish('6c200000-0000-0000-0000-000000000005', 1, 'user', null, null, :'ext_b');
select pg_temp.reset_actor();
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000006c1","role":"authenticated"}', false);
select pg_temp.assert_error(
  format($q$do $d$ begin
       update public.content_publish_requests set status = 'approved'
        where post_id = '6c200000-0000-0000-0000-000000000005' and destination_id = %L;
       update public.content_posts set status = 'published' where id = '6c200000-0000-0000-0000-000000000005';
     end $d$$q$, :'ext_b'),
  '42501', 'an approval for an external destination cannot publish the post internally');
select set_config('request.jwt.claims', '', false);
select pg_temp.assert(
  (select status = 'draft' from public.content_posts where id = '6c200000-0000-0000-0000-000000000005')
  and (select status = 'pending' from public.content_publish_requests where post_id = '6c200000-0000-0000-0000-000000000005'),
  'nothing changed after the rejected attempt');

-- Disabled destinations: no new requests, no approvals.
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c2');
update public.publishing_destinations set status = 'disabled' where id = :'ext_b';
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c3');
select pg_temp.assert_error(
  format($q$select public.request_post_publish('6c200000-0000-0000-0000-000000000006', 1, 'user', null, null, %L)$q$, :'ext_b'),
  'CP426', 'a disabled destination accepts no new request');
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c1');
select pg_temp.assert_error(
  format($q$select public.approve_publish_request(%L, 1, %L)$q$,
         pg_temp.request_of('6c200000-0000-0000-0000-000000000005'), :'ext_b'),
  'CP426', 'a request for a destination disabled meanwhile cannot be approved');
select pg_temp.reset_actor();
select pg_temp.assert(
  not exists (select 1 from public.publish_deliveries where destination_id = :'ext_b'),
  'no delivery for the disabled destination');

-- The internal request of post 4 is still approved normally, with its own delivery.
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c1');
select pg_temp.assert(
  (select p.status = 'published' from public.approve_publish_request(
     (select id from public.content_publish_requests where post_id = '6c200000-0000-0000-0000-000000000004'
        and destination_id = pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')), 1,
     pg_temp.internal_of('6c000000-0000-0000-0000-000000000001')) p),
  'the internal request of the same post is approved separately');
select pg_temp.reset_actor();
select pg_temp.assert(
  (select array_agg(d.status order by d.status) from public.publish_deliveries d where d.post_id = '6c200000-0000-0000-0000-000000000004')
  = array['queued', 'succeeded'],
  'one delivery per approved destination: queued (external) and succeeded (internal)');

-- Workspace isolation of deliveries and destinations still holds with several destinations.
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c4');
select pg_temp.assert(
  (select count(*) = 0 from public.publish_deliveries where workspace_id = '6c000000-0000-0000-0000-000000000001')
  and (select count(*) = 0 from public.publishing_destinations where workspace_id = '6c000000-0000-0000-0000-000000000001'),
  'an outsider sees none of the destinations or deliveries');
select pg_temp.reset_actor();

-- 8. Deleting an empty workspace still works (M1 behaviour) -------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000006c4');
select pg_temp.assert(
  pg_temp.affected($q$delete from public.workspaces where id = '6c000000-0000-0000-0000-000000000009'$q$) = 1,
  'an owner can still delete an empty workspace (its internal destination goes with it)');
select pg_temp.reset_actor();
select pg_temp.assert(
  not exists (select 1 from public.publishing_destinations where workspace_id = '6c000000-0000-0000-0000-000000000009'),
  'the destination of the deleted workspace is gone');
