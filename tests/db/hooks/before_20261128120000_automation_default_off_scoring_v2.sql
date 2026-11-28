-- FN07-B: legacy data that exists BEFORE migration 20261128120000 (default Off + scoring V2).
-- Runs with every earlier migration applied (unconfigured projects still read as Semi at this point).
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
  ('00000000-0000-0000-0000-0000000007f1', 'fn07-owner@example.test'),
  ('00000000-0000-0000-0000-0000000007f2', 'fn07-other-owner@example.test');

select pg_temp.act_as('00000000-0000-0000-0000-0000000007f1');
insert into public.workspaces (id, name) values ('7f000000-0000-0000-0000-000000000001', 'FN07 WS A');
insert into public.content_projects (id, workspace_id, name) values
  ('7f100000-0000-0000-0000-000000000001', '7f000000-0000-0000-0000-000000000001', 'legacy default scoring, unconfigured mode'),
  ('7f100000-0000-0000-0000-000000000002', '7f000000-0000-0000-0000-000000000001', 'custom scoring, explicit Semi');
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000007f2');
insert into public.workspaces (id, name) values ('7f000000-0000-0000-0000-000000000002', 'FN07 WS B');
insert into public.content_projects (id, workspace_id, name)
  values ('7f100000-0000-0000-0000-000000000003', '7f000000-0000-0000-0000-000000000002', 'other workspace, legacy default scoring');
select pg_temp.reset_actor();

insert into public.publishing_destinations (id, workspace_id, kind, name, target_ref)
values ('7f600000-0000-4000-8000-000000000001', '7f000000-0000-0000-0000-000000000001', 'telegram', 'FN07 channel', '-100777000');

-- Scoring: shipped legacy default (45/40/15), an explicit custom rubric (50/30/20) and another workspace's default.
insert into public.sports_news_scoring_configs (workspace_id, project_id, threshold, reach_weight, importance_weight, freshness_weight, fallback_mode) values
  ('7f000000-0000-0000-0000-000000000001', '7f100000-0000-0000-0000-000000000001', 8.0, 45, 40, 15, 'highest'),
  ('7f000000-0000-0000-0000-000000000001', '7f100000-0000-0000-0000-000000000002', 7.5, 50, 30, 20, 'strict'),
  ('7f000000-0000-0000-0000-000000000002', '7f100000-0000-0000-0000-000000000003', 8.0, 45, 40, 15, 'highest');

-- Historical scored items (no post: they must stay byte-for-byte identical afterwards).
insert into public.sports_news_items (workspace_id, project_id, source_url, headline_key, score, assessment) values
  ('7f000000-0000-0000-0000-000000000001', '7f100000-0000-0000-0000-000000000001', 'https://fn07.example/h1', repeat('1',64), 8.4,
   '{"rubricVersion":"sports-v1","decision":"threshold_met","scores":{"reach":9,"importance":8,"freshness":7}}'),
  ('7f000000-0000-0000-0000-000000000001', '7f100000-0000-0000-0000-000000000002', 'https://fn07.example/h2', repeat('2',64), 6.3,
   '{"rubricVersion":"sports-v1","decision":"highest_below_threshold"}');

-- Explicit Semi project with an already APPROVED, queued delivery (must keep resuming after the migration).
insert into contentpilot_private.sports_automation_modes (workspace_id, project_id, destination_id, mode, daily_quota)
values ('7f000000-0000-0000-0000-000000000001', '7f100000-0000-0000-0000-000000000002', '7f600000-0000-4000-8000-000000000001', 'semi', 25);

select pg_temp.act_as('00000000-0000-0000-0000-0000000007f1');
insert into public.content_posts (id, workspace_id, project_id, title)
  values ('7f200000-0000-0000-0000-000000000001', '7f000000-0000-0000-0000-000000000001', '7f100000-0000-0000-0000-000000000002', 'Approved before migration');
select public.request_post_publish('7f200000-0000-0000-0000-000000000001', 1, 'user', null, null, '7f600000-0000-4000-8000-000000000001');
select public.approve_publish_request((select id from public.content_publish_requests where post_id = '7f200000-0000-0000-0000-000000000001'), 1,
  '7f600000-0000-4000-8000-000000000001');
select pg_temp.reset_actor();

-- Snapshot the pre-migration state so the post-migration test can compare it.
create schema fn07_snapshot;
create table fn07_snapshot.items as select project_id, source_url, score, assessment::text as assessment from public.sports_news_items
  where workspace_id = '7f000000-0000-0000-0000-000000000001';
create table fn07_snapshot.pre_mode as select contentpilot_private.automation_mode('7f000000-0000-0000-0000-000000000001', '7f100000-0000-0000-0000-000000000001') as unconfigured_mode;
do $$ begin
  if (select unconfigured_mode from fn07_snapshot.pre_mode) <> 'semi' then raise exception 'pre-migration fixture: expected legacy Semi default'; end if;
  if (select status from public.publish_deliveries where post_id = '7f200000-0000-0000-0000-000000000001') <> 'queued' then
    raise exception 'pre-migration fixture: approved delivery should be queued'; end if;
  raise notice 'fn07 pre-migration fixture seeded (legacy default = semi, approved delivery queued)';
end $$;
