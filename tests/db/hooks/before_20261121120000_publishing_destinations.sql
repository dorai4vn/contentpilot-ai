-- Pre-migration data for the M4.6a backfill test (tests/db/60_publishing_destinations.sql).
-- Runs with all earlier migrations applied, BEFORE 20261121120000_publishing_destinations.sql:
-- workspaces, a published post (approved request) and a pending request, as in M4.

\set ON_ERROR_STOP on

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;
create or replace function pg_temp.reset_actor() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000006b1', 'legacy-owner@example.test'),
  ('00000000-0000-0000-0000-0000000006b2', 'legacy-member@example.test');

select pg_temp.act_as('00000000-0000-0000-0000-0000000006b1');
insert into public.workspaces (id, name) values
  ('6b000000-0000-0000-0000-000000000001', 'Legacy WS'),
  ('6b000000-0000-0000-0000-000000000002', 'Legacy empty WS');
insert into public.workspace_members (workspace_id, user_id, role)
  values ('6b000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000006b2', 'member');
insert into public.content_projects (id, workspace_id, name)
  values ('6b100000-0000-0000-0000-000000000001', '6b000000-0000-0000-0000-000000000001', 'Legacy blog');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000006b2');
insert into public.content_posts (id, workspace_id, project_id, title) values
  ('6b200000-0000-0000-0000-000000000001', '6b000000-0000-0000-0000-000000000001', '6b100000-0000-0000-0000-000000000001', 'Legacy published'),
  ('6b200000-0000-0000-0000-000000000002', '6b000000-0000-0000-0000-000000000001', '6b100000-0000-0000-0000-000000000001', 'Legacy pending');
select public.request_post_publish('6b200000-0000-0000-0000-000000000001', 1);
select public.request_post_publish('6b200000-0000-0000-0000-000000000002', 1);
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000006b1');
select public.approve_publish_request(
  (select id from public.content_publish_requests where post_id = '6b200000-0000-0000-0000-000000000001'), 1);
select pg_temp.reset_actor();
