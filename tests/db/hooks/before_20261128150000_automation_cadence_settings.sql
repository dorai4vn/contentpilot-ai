-- FN09: legacy mode rows that exist BEFORE the cadence migration. An explicit custom quota (25), a quota of 40
-- (indistinguishable from the old default 40: the form always submitted a value) and an Auto row.
\set ON_ERROR_STOP on
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000009f1', 'fn09-owner@example.test');
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000009f1', false);
insert into public.workspaces (id, name) values ('9f000000-0000-0000-0000-000000000001', 'FN09 WS');
insert into public.content_projects (id, workspace_id, name) values
  ('9f100000-0000-0000-0000-000000000001', '9f000000-0000-0000-0000-000000000001', 'custom 25'),
  ('9f100000-0000-0000-0000-000000000002', '9f000000-0000-0000-0000-000000000001', 'quota 40');
reset role;
insert into public.publishing_destinations (id, workspace_id, kind, name, target_ref)
values ('9f600000-0000-4000-8000-000000000001', '9f000000-0000-0000-0000-000000000001', 'telegram', 'FN09 channel', '-100999000');
insert into contentpilot_private.sports_automation_modes (workspace_id, project_id, destination_id, mode, daily_quota) values
  ('9f000000-0000-0000-0000-000000000001', '9f100000-0000-0000-0000-000000000001', '9f600000-0000-4000-8000-000000000001', 'semi', 25),
  ('9f000000-0000-0000-0000-000000000001', '9f100000-0000-0000-0000-000000000002', '9f600000-0000-4000-8000-000000000001', 'semi', 40);
