-- FN10: events that exist BEFORE the retention migration. Scope A: 8 old events (all 60-90 days old) -> 5 stay
-- visible (even though old), 3 become hidden at migration time and are NOT deleted. Scope B: 3 events (no excess).
\set ON_ERROR_STOP on
insert into contentpilot_private.sports_automation_events (id, workspace_id, project_id, from_mode, to_mode, daily_quota, created_at)
select ('a0000000-0000-0000-0000-00000000000' || n)::uuid, 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
       'off', 'semi', 20, timestamptz '2026-01-01 00:00:00+00' + (n || ' days')::interval
from generate_series(1, 8) n;
insert into contentpilot_private.sports_automation_events (id, workspace_id, project_id, from_mode, to_mode, daily_quota, created_at)
select ('b0000000-0000-0000-0000-00000000000' || n)::uuid, 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000002',
       'off', 'semi', 20, timestamptz '2026-01-01 00:00:00+00' + (n || ' days')::interval
from generate_series(1, 3) n;
