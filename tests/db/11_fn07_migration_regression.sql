\set ON_ERROR_STOP on
-- FN07-B: post-migration assertions on data seeded BEFORE migration 20261128120000
-- (tests/db/hooks/before_20261128120000_automation_default_off_scoring_v2.sql).

create function pg_temp.chk(ok boolean, message text) returns void language plpgsql as $$
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
create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
  perform set_config('request.jwt.claim.sub', p_user::text, false);
  execute 'set role authenticated';
end $$;
create function pg_temp.reset_actor() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
grant execute on function pg_temp.act_as(uuid), pg_temp.reset_actor(), pg_temp.chk(boolean,text), pg_temp.denied(text,text,text) to public;

\set wsa '7f000000-0000-0000-0000-000000000001'
\set wsb '7f000000-0000-0000-0000-000000000002'
\set p_legacy '7f100000-0000-0000-0000-000000000001'
\set p_custom '7f100000-0000-0000-0000-000000000002'
\set p_other '7f100000-0000-0000-0000-000000000003'
\set chan '7f600000-0000-4000-8000-000000000001'
\set ownera '00000000-0000-0000-0000-0000000007f1'
\set ownerb '00000000-0000-0000-0000-0000000007f2'

-- ---- Scoring V2 migration -------------------------------------------------------------------------
select pg_temp.chk((select (reach_weight, importance_weight, freshness_weight, engagement_weight) = (30,25,25,20) and version = 2
  from public.sports_news_scoring_configs where project_id = :'p_legacy'), 'legacy default 45/40/15 -> V2 30/25/25/20 (version bumped)');
select pg_temp.chk((select (reach_weight, importance_weight, freshness_weight, engagement_weight, threshold, fallback_mode, version) = (50,30,20,0,7.5,'strict',1)
  from public.sports_news_scoring_configs where project_id = :'p_custom'), 'custom 50/30/20 preserved with engagement 0, threshold/fallback/version untouched');
select pg_temp.chk((select (reach_weight, importance_weight, freshness_weight, engagement_weight) = (30,25,25,20)
  from public.sports_news_scoring_configs where project_id = :'p_other'), 'other workspace legacy default also moves to V2');
select pg_temp.chk((select count(*) = 0 from (select project_id, source_url, score, assessment::text from public.sports_news_items where workspace_id = :'wsa'
  except select * from fn07_snapshot.items) x) and (select count(*) = 2 from public.sports_news_items where workspace_id = :'wsa'),
  'historical scores/assessments (sports-v1) are byte-identical after migration');
select pg_temp.chk((select column_default from information_schema.columns where table_name='sports_news_scoring_configs' and column_name='engagement_weight') = '20',
  'new scoring rows default to engagement 20');
select pg_temp.denied($$update public.sports_news_scoring_configs set engagement_weight = 5 where project_id = '7f100000-0000-0000-0000-000000000002'$$, '23514',
  'weights that do not sum to 100 are rejected by the constraint');
select pg_temp.chk(not exists (select 1 from pg_proc where proname = 'set_sports_news_scoring_config' and pronargs = 7), 'old 7-arg scoring setter is gone');

-- ---- Default Off / Emergency Stop semantics ---------------------------------------------------------
select pg_temp.chk(contentpilot_private.automation_mode(:'wsa', :'p_legacy') = 'off', 'unconfigured project reads Off after migration (was Semi before)');
select pg_temp.chk((select unconfigured_mode from fn07_snapshot.pre_mode) = 'semi', 'fixture really was Semi before the migration (pre/post transition proven)');
select pg_temp.act_as(:'ownera');
select pg_temp.chk((select (mode, daily_quota, version) = ('off', 20, 0) from public.get_sports_automation_mode(:'wsa', :'p_legacy')), 'owner RPC: unconfigured => off / quota 20 (FN09 default) / version 0');
select pg_temp.chk((select (mode, daily_quota) = ('semi', 25) from public.get_sports_automation_mode(:'wsa', :'p_custom')), 'explicit Semi row and its quota survive the migration');
select pg_temp.reset_actor();

-- ---- ACL / workspace isolation ------------------------------------------------------------------
select pg_temp.act_as(:'ownerb');
select pg_temp.denied($$select * from public.get_sports_automation_mode('7f000000-0000-0000-0000-000000000001','7f100000-0000-0000-0000-000000000001')$$, '42501', 'workspace B owner cannot read workspace A mode');
select pg_temp.denied($$select public.set_sports_automation_mode('7f000000-0000-0000-0000-000000000001','7f100000-0000-0000-0000-000000000001','7f600000-0000-4000-8000-000000000001','auto',40)$$, '42501', 'workspace B owner cannot switch workspace A mode');
select pg_temp.denied($$select public.set_sports_news_scoring_config('7f000000-0000-0000-0000-000000000001','7f100000-0000-0000-0000-000000000001',8,30,25,25,20,'highest')$$, '42501', 'workspace B owner cannot change workspace A scoring');
select pg_temp.chk((select count(*) = 0 from public.sports_news_scoring_configs where workspace_id = :'wsa'), 'RLS: workspace B sees none of workspace A scoring configs');
select pg_temp.chk((select count(*) = 0 from public.sports_news_items where workspace_id = :'wsa'), 'RLS: workspace B sees none of workspace A news items');
select pg_temp.denied($$select public.set_sports_news_scoring_config('7f000000-0000-0000-0000-000000000002','7f100000-0000-0000-0000-000000000001',8,30,25,25,20,'highest')$$, '22023', 'workspace/project mismatch is rejected (Project unavailable), config untouched');
select pg_temp.reset_actor();
set role anon;
select pg_temp.denied($$select * from public.get_sports_automation_mode('7f000000-0000-0000-0000-000000000001','7f100000-0000-0000-0000-000000000001')$$, '42501', 'anon cannot execute get_sports_automation_mode');
select pg_temp.denied($$select public.set_sports_news_scoring_config('7f000000-0000-0000-0000-000000000001','7f100000-0000-0000-0000-000000000001',8,30,25,25,20,'highest')$$, '42501', 'anon cannot execute the scoring setter');
reset role;
select pg_temp.act_as(:'ownera');
select pg_temp.denied($$select contentpilot_private.automation_mode('7f000000-0000-0000-0000-000000000001','7f100000-0000-0000-0000-000000000001')$$, '42501', 'private mode helper is not callable by authenticated users');
select pg_temp.denied($$select public.set_sports_automation_mode('7f000000-0000-0000-0000-000000000001','7f100000-0000-0000-0000-000000000002','7f600000-0000-4000-8000-000000000001','auto',0)$$, '22023', 'quota 0 rejected');
select pg_temp.denied($$select public.set_sports_automation_mode('7f000000-0000-0000-0000-000000000001','7f100000-0000-0000-0000-000000000002','7f600000-0000-4000-8000-000000000001','auto',121)$$, '22023', 'quota 121 rejected');
select pg_temp.denied($$select public.set_sports_automation_mode('7f000000-0000-0000-0000-000000000001','7f100000-0000-0000-0000-000000000002','7f600000-0000-4000-8000-000000000001','bogus',40)$$, '22023', 'unknown mode rejected');
select pg_temp.reset_actor();

-- ---- Approved queue transitions (approval predates the migration) --------------------------------------
select '7f000000-0000-0000-0000-0000000007f3' as worker \gset
insert into auth.users (id, email) values (:'worker', 'fn07-worker@example.test');
insert into public.workspace_members (workspace_id, user_id, role) values (:'wsa', :'worker', 'member');
insert into contentpilot_private.sports_news_workers values (:'wsa', :'worker');
create function pg_temp.claim_count() returns bigint language sql as $$
  select count(*) from public.claim_social_deliveries('7f000000-0000-0000-0000-000000000001', array['7f600000-0000-4000-8000-000000000001'::uuid]) $$;
grant execute on function pg_temp.claim_count() to public;
create function pg_temp.dstatus() returns text language sql as $$
  select status from public.publish_deliveries where post_id = '7f200000-0000-0000-0000-000000000001' $$;
grant execute on function pg_temp.dstatus() to public;

-- Off: approved delivery waits (no send); Off -> Semi: resumes; the version-1 request approval is preserved.
select pg_temp.act_as(:'ownera');
select pg_temp.chk(public.set_sports_automation_mode(:'wsa', :'p_custom', :'chan', 'off', 25) = 2, 'Emergency-Stop equivalent: Semi -> Off bumps version');
select pg_temp.reset_actor();
select pg_temp.act_as(:'worker');
select pg_temp.chk(pg_temp.claim_count() = 0, 'Off: approved queued delivery is NOT claimed (zero external work)');
select pg_temp.reset_actor();
select pg_temp.chk((select status = 'queued' and post_version = 1 from public.publish_deliveries where post_id = '7f200000-0000-0000-0000-000000000001'), 'approved delivery still queued at the approved version while Off');
select pg_temp.act_as(:'ownera');
select pg_temp.chk(public.set_sports_automation_mode(:'wsa', :'p_custom', :'chan', 'semi', 25) = 3, 'Off -> Semi');
select pg_temp.reset_actor();
select pg_temp.act_as(:'worker');
select pg_temp.chk(pg_temp.claim_count() = 1, 'Semi: approved delivery resumes and is claimed exactly once');
select pg_temp.chk(pg_temp.claim_count() = 0, 'a claimed delivery is not claimed twice');
select pg_temp.reset_actor();
select pg_temp.chk(pg_temp.dstatus() = 'sending', 'delivery transitioned queued -> sending');
-- Unconfigured destination (mode row removed) never delivers; Auto-less Semi never opens a window.
update public.publish_deliveries set status = 'queued', next_attempt_at = now() where post_id = '7f200000-0000-0000-0000-000000000001';
delete from contentpilot_private.sports_automation_modes where project_id = :'p_custom';
select pg_temp.act_as(:'worker');
select pg_temp.chk(pg_temp.claim_count() = 0, 'no mode configuration => nothing is delivered (fail safe Off)');
select pg_temp.reset_actor();
select pg_temp.chk((select count(*) = 0 from contentpilot_private.sports_auto_publish_windows where project_id = :'p_custom' and persistent and ends_at > now()),
  'Semi/Off never leaves an open persistent Auto window');
select pg_temp.chk((select count(*) >= 1 from contentpilot_private.sports_automation_events where project_id = :'p_custom' and to_mode = 'off'), 'mode transitions are audited');

-- FN09 migration behaviour for rows that pre-date it (seeded by hooks/before_20261128150000_*; 90_ later wipes mode rows).
select pg_temp.chk((select daily_quota = 25 and scan_interval_hours = 2 and posts_per_scan = 2 and last_scan_at is null
  from contentpilot_private.sports_automation_modes where project_id = '9f100000-0000-0000-0000-000000000001'), 'existing custom quota 25 is preserved; new settings get defaults');
select pg_temp.chk((select daily_quota = 40 and version = 1 from contentpilot_private.sports_automation_modes where project_id = '9f100000-0000-0000-0000-000000000002'), 'existing quota 40 is NOT rewritten to 20 (default 40 and explicit 40 are indistinguishable)');
