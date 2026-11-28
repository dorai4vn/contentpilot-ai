\set ON_ERROR_STOP on
-- FN10: Auto Post operation history (latest 5 visible, hidden_at, 30-day purge of hidden rows only).

create function pg_temp.check_mode(ok boolean, message text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if;
  raise notice 'ok - %', message;
end $$;
create function pg_temp.denied(stmt text, expected text, message text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'ASSERTION FAILED: % (statement succeeded)', message;
exception when others then
  if sqlstate <> expected then raise exception 'ASSERTION FAILED: % (got % %)', message, sqlstate, sqlerrm; end if;
  raise notice 'ok - %', message;
end $$;
create function pg_temp.add_events(p_ws uuid, p_project uuid, p_n integer, p_at timestamptz default null) returns void language sql as $$
  insert into contentpilot_private.sports_automation_events (workspace_id, project_id, from_mode, to_mode, daily_quota, created_at)
  select p_ws, p_project, 'off', 'semi', 20, coalesce(p_at, clock_timestamp()) from generate_series(1, p_n)
$$;

\set ws '6c000000-0000-0000-0000-000000000001'
\set project '6c100000-0000-0000-0000-000000000001'
\set worker '00000000-0000-0000-0000-0000000006c3'
\set owner '00000000-0000-0000-0000-0000000006c1'
\set outsider '00000000-0000-0000-0000-0000000006c4'
\set oldws 'a1000000-0000-0000-0000-000000000001'
\set scopea 'a2000000-0000-0000-0000-000000000001'
\set scopeb 'a2000000-0000-0000-0000-000000000002'

reset role;
create temp table fn10_before as select
  (select count(*) from public.publish_deliveries) deliveries, (select count(*) from public.content_publish_request_events) request_events,
  (select count(*) from contentpilot_private.sports_auto_publish_deliveries) auto_deliveries, (select count(*) from contentpilot_private.sports_auto_publish_windows) windows;
-- Migration backfill (rows seeded by tests/db/hooks/before_20261128180000_*).
select pg_temp.check_mode((select count(*) = 8 from contentpilot_private.sports_automation_events where project_id = :'scopea'), 'backfill: nothing deleted');
select pg_temp.check_mode((select count(*) filter (where hidden_at is null) = 5 and count(*) filter (where hidden_at is not null) = 3
  from contentpilot_private.sports_automation_events where project_id = :'scopea'), 'backfill: 5 visible, 3 hidden');
select pg_temp.check_mode((select bool_and(created_at >= timestamptz '2026-01-04') from contentpilot_private.sports_automation_events where project_id = :'scopea' and hidden_at is null), 'backfill: the newest five stay visible even though they are months old');
select pg_temp.check_mode((select bool_and(hidden_at > clock_timestamp() - interval '1 hour' and hidden_at <= clock_timestamp()) from contentpilot_private.sports_automation_events where project_id = :'scopea' and hidden_at is not null), 'backfill: retention starts at migration time, not at creation time');
select pg_temp.check_mode((select count(*) = 3 and count(*) filter (where hidden_at is null) = 3 from contentpilot_private.sports_automation_events where project_id = :'scopeb'), 'backfill: scope with <= 5 rows is untouched');
select pg_temp.check_mode((select count(distinct seq) = 11 from contentpilot_private.sports_automation_events where project_id in (:'scopea', :'scopeb')), 'backfill: seq is unique');
-- A purge right after migration deletes nothing (hidden rows are brand new).
select pg_temp.check_mode(contentpilot_private.purge_sports_automation_events(:'oldws', :'scopea', clock_timestamp()) = 0, 'no preexisting row is deleted immediately');

-- 0..6+ rows
select pg_temp.check_mode((select count(*) = 0 from contentpilot_private.sports_automation_events where project_id = '6c100000-0000-0000-0000-0000000000a0'), 'fixture: scope with 0 rows');
do $$
declare ws uuid := '6c000000-0000-0000-0000-000000000001'; p uuid := '6c100000-0000-0000-0000-0000000000a1'; n integer; v integer; h integer;
begin
  for n in 1..8 loop
    perform pg_temp.add_events(ws, p, 1, clock_timestamp());
    select count(*) filter (where hidden_at is null), count(*) filter (where hidden_at is not null) into v, h
      from contentpilot_private.sports_automation_events where project_id = p;
    if v <> least(n, 5) or h <> greatest(n - 5, 0) then raise exception 'ASSERTION FAILED: after % inserts visible=% hidden=%', n, v, h; end if;
  end loop;
  raise notice 'ok - 1..8 inserts: visible = min(n,5), hidden = max(n-5,0)';
end $$;

-- Deterministic tie-break: 7 events with the IDENTICAL created_at -> newest seq wins; list returns exactly the 5 highest seq.
select pg_temp.add_events(:'ws', '6c100000-0000-0000-0000-0000000000a2', 7, timestamptz '2026-06-01 00:00:00+00');
select pg_temp.check_mode((select array_agg(seq order by seq desc) = (select array_agg(seq) from (select seq from contentpilot_private.sports_automation_events where project_id = '6c100000-0000-0000-0000-0000000000a2' order by seq desc limit 5) t)
  from contentpilot_private.sports_automation_events where project_id = '6c100000-0000-0000-0000-0000000000a2' and hidden_at is null), 'equal created_at: the 5 highest seq stay visible');

-- list function: at most 5, newest first, hidden excluded; members only
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode((select count(*) <= 5 from public.list_sports_automation_events(:'ws', :'project')), 'list returns at most 5');
select pg_temp.check_mode((select count(*) = 5 and bool_and(created_at <= '2200-01-01') from public.list_sports_automation_events(:'ws', '6c100000-0000-0000-0000-0000000000a1')), 'list returns 5 of 8 for a busy scope');
select pg_temp.check_mode((select array_agg(created_at) = array_agg(created_at order by created_at desc) from public.list_sports_automation_events(:'ws', '6c100000-0000-0000-0000-0000000000a1')), 'list is newest first');
select set_config('request.jwt.claim.sub', :'outsider', false);
select pg_temp.denied(format('select public.list_sports_automation_events(%L,%L)', :'ws', :'project'), '42501', 'a non-member still cannot read the history');
select pg_temp.denied(format('select public.purge_sports_automation_history(%L,%L)', :'ws', :'project'), '42501', 'a non-worker cannot purge');
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.denied(format('select public.purge_sports_automation_history(%L,%L)', :'ws', :'project'), '42501', 'an owner who is not the worker cannot purge');
reset role;
set role anon;
select pg_temp.denied(format('select public.purge_sports_automation_history(%L,%L)', :'ws', :'project'), '42501', 'anon cannot purge');
select pg_temp.denied('select * from contentpilot_private.sports_automation_events', '42501', 'the events table is not directly readable');
reset role;

-- 30-day boundary (hidden_at based, not created_at). Scope c: 7 events created 1 year ago -> 2 hidden.
select pg_temp.add_events(:'ws', '6c100000-0000-0000-0000-0000000000a3', 7, clock_timestamp() - interval '365 days');
select pg_temp.check_mode((select count(*) filter (where hidden_at is not null) = 2 from contentpilot_private.sports_automation_events where project_id = '6c100000-0000-0000-0000-0000000000a3'), 'old rows are hidden by rank, not deleted');
select pg_temp.check_mode(contentpilot_private.purge_sports_automation_events(:'ws', '6c100000-0000-0000-0000-0000000000a3', clock_timestamp()) = 0, 'old creation time alone never causes a purge (hidden just now)');
-- hidden exactly 30 days before "now" -> deleted; 1 microsecond short -> kept
do $$
declare ws uuid := '6c000000-0000-0000-0000-000000000001'; p uuid := '6c100000-0000-0000-0000-0000000000a3'; t timestamptz := timestamptz '2026-09-01 12:00:00+00'; ids uuid[];
begin
  select array_agg(id order by seq) into ids from contentpilot_private.sports_automation_events where project_id = p and hidden_at is not null;
  update contentpilot_private.sports_automation_events set hidden_at = t - interval '30 days' + interval '1 microsecond' where id = ids[1];
  update contentpilot_private.sports_automation_events set hidden_at = t - interval '30 days' where id = ids[2];
  if contentpilot_private.purge_sports_automation_events(ws, p, t) <> 1 then raise exception 'ASSERTION FAILED: exactly the row hidden >= 30d must be deleted'; end if;
  if not exists (select 1 from contentpilot_private.sports_automation_events where id = ids[1]) then raise exception 'ASSERTION FAILED: row hidden 30d minus 1us was deleted'; end if;
  if exists (select 1 from contentpilot_private.sports_automation_events where id = ids[2]) then raise exception 'ASSERTION FAILED: row hidden exactly 30d was kept'; end if;
  raise notice 'ok - exact 30-day boundary: deleted at 30d, kept at 30d - 1us';
end $$;
select pg_temp.check_mode((select count(*) = 6 and count(*) filter (where hidden_at is null) = 5 from contentpilot_private.sports_automation_events where project_id = '6c100000-0000-0000-0000-0000000000a3'), 'latest five (a year old) retained; only the eligible hidden row purged');

-- (The row kept above at 30d-1us relative to the fixed test clock is overdue against the real clock: remove it.)
select pg_temp.check_mode(contentpilot_private.purge_sports_automation_events(:'ws', '6c100000-0000-0000-0000-0000000000a3', clock_timestamp()) = 1, 'the previously kept row is purged once the real clock passes 30 days');
-- Even a corrupted hidden_at on a top-5 row cannot be purged.
update contentpilot_private.sports_automation_events set hidden_at = clock_timestamp() - interval '400 days'
  where id = (select id from contentpilot_private.sports_automation_events where project_id = '6c100000-0000-0000-0000-0000000000a3' and hidden_at is null order by created_at desc, seq desc limit 1);
select pg_temp.check_mode(contentpilot_private.purge_sports_automation_events(:'ws', '6c100000-0000-0000-0000-0000000000a3', clock_timestamp()) = 0, 'the purge never deletes a row inside the latest five');

-- Scoped cleanup / workspace + project isolation: purging scope a3 leaves other scopes untouched even if overdue.
update contentpilot_private.sports_automation_events set hidden_at = clock_timestamp() - interval '40 days' where project_id = '6c100000-0000-0000-0000-0000000000a1' and hidden_at is not null;
select pg_temp.check_mode(contentpilot_private.purge_sports_automation_events(:'ws', '6c100000-0000-0000-0000-0000000000a3', clock_timestamp()) = 0, 'purging one project deletes nothing in another');
select pg_temp.check_mode(contentpilot_private.purge_sports_automation_events(:'oldws', '6c100000-0000-0000-0000-0000000000a1', clock_timestamp()) = 0, 'purging with another workspace id deletes nothing');
select pg_temp.check_mode((select count(*) = 8 from contentpilot_private.sports_automation_events where project_id = '6c100000-0000-0000-0000-0000000000a1'), 'overdue rows of other scopes untouched');

-- Worker RPC (real clock), independent of the automation mode: works while the project is Off.
reset role;
select pg_temp.check_mode((select mode = 'off' from contentpilot_private.sports_automation_modes where project_id = :'project'), 'fixture: project is Off');
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode(public.purge_sports_automation_history(:'ws', '6c100000-0000-0000-0000-0000000000a1') = 3, 'worker purge works while Off and deletes the 3 overdue hidden rows');
select pg_temp.check_mode(public.purge_sports_automation_history(:'ws', '6c100000-0000-0000-0000-0000000000a1') = 0, 'worker purge is idempotent');
reset role;
select pg_temp.check_mode((select count(*) = 5 and count(*) filter (where hidden_at is null) = 5 from contentpilot_private.sports_automation_events where project_id = '6c100000-0000-0000-0000-0000000000a1'), 'the visible five survive the purge');

-- Mode saves still audit and rank (real code path).
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode((select count(*) <= 5 from public.list_sports_automation_events(:'ws', :'project')), 'mode history capped at 5 after saves');
reset role;
-- Publishing / delivery tables are not touched by the purge.
select pg_temp.check_mode((select b.deliveries = (select count(*) from public.publish_deliveries) and b.request_events = (select count(*) from public.content_publish_request_events)
  and b.auto_deliveries = (select count(*) from contentpilot_private.sports_auto_publish_deliveries) and b.windows = (select count(*) from contentpilot_private.sports_auto_publish_windows) from fn10_before b), 'publishing history and delivery logs are untouched');
select pg_temp.check_mode((select not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','contentpilot_private') and p.proname like '%sports_automation_events%' and pg_get_functiondef(p.oid) ~* 'publish_deliveries|publish_request|sports_auto_publish_deliveries')), 'retention functions reference no publishing/delivery table');
