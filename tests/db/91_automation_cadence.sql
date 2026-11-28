\set ON_ERROR_STOP on
-- FN09: configurable Auto Post cadence (daily limit / scan interval / posts per scan). Reuses the 90_ fixtures.

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
create function pg_temp.draft(p_url text) returns uuid language sql as $$
  select public.record_sports_news_assessment('6c000000-0000-0000-0000-000000000001', '6c100000-0000-0000-0000-000000000001',
    p_url, encode(sha256(convert_to('fn09' || p_url, 'UTF8')), 'hex'), 9, 'Tin ' || p_url, 'Caption', null, 'Test', array['60000000-0000-4000-8000-000000000080'::uuid],
    jsonb_build_object('publishedAt', clock_timestamp(), 'rubricVersion', 'sports-v2', 'decision', 'threshold_met'))
$$;
grant execute on function pg_temp.draft(text) to public;
create function pg_temp.claim(p_post uuid) returns integer language sql as $$
  select count(*)::integer from public.claim_sports_auto_publish('6c000000-0000-0000-0000-000000000001', '6c100000-0000-0000-0000-000000000001', '60000000-0000-4000-8000-000000000080', p_post)
$$;
grant execute on function pg_temp.claim(uuid) to public;

\set ws '6c000000-0000-0000-0000-000000000001'
\set project '6c100000-0000-0000-0000-000000000001'
\set other_project '6c100000-0000-0000-0000-0000000000ff'
\set worker '00000000-0000-0000-0000-0000000006c3'
\set owner '00000000-0000-0000-0000-0000000006c1'
\set outsider '00000000-0000-0000-0000-0000000006c4'
\set channel '60000000-0000-4000-8000-000000000080'

reset role;
select pg_temp.check_mode((select column_default from information_schema.columns where table_name='sports_automation_modes' and column_name='daily_quota') = '20', 'new rows default to 20 posts/day');
select pg_temp.check_mode((select (column_default::int = 2) from information_schema.columns where table_name='sports_automation_modes' and column_name='scan_interval_hours'), 'default scan interval 2h');
select pg_temp.check_mode((select (column_default::int = 2) from information_schema.columns where table_name='sports_automation_modes' and column_name='posts_per_scan'), 'default 2 posts per scan');
-- table CHECKs back the RPC validation
select pg_temp.denied(format('update contentpilot_private.sports_automation_modes set scan_interval_hours = 3 where project_id = %L', :'project'), '23514', 'table rejects an odd interval');
select pg_temp.denied(format('update contentpilot_private.sports_automation_modes set posts_per_scan = 11 where project_id = %L', :'project'), '23514', 'table rejects 11 posts per scan');

set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode((select (mode, daily_quota, scan_interval_hours, posts_per_scan) = ('off', 20, 2, 2) from public.get_sports_automation_mode(:'ws', :'other_project')), 'unconfigured project reads Off / 20 / 2h / 2 posts');
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''auto'',20,1,2)', :'ws', :'project', :'channel'), '22023', 'interval 1h rejected');
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''auto'',20,3,2)', :'ws', :'project', :'channel'), '22023', 'interval 3h (not a 2h multiple) rejected');
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''auto'',20,26,2)', :'ws', :'project', :'channel'), '22023', 'interval 26h rejected');
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''auto'',20,2,0)', :'ws', :'project', :'channel'), '22023', 'posts per scan 0 rejected');
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''auto'',20,2,11)', :'ws', :'project', :'channel'), '22023', 'posts per scan 11 rejected');
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''auto'',121,2,2)', :'ws', :'project', :'channel'), '22023', 'daily limit above 120 still rejected');
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''auto'',20,2,2)', :'ws', :'project', :'channel'), '42501', 'a Member cannot change cadence settings');
select set_config('request.jwt.claim.sub', :'outsider', false);
select pg_temp.denied(format('select public.begin_sports_scan(%L,%L)', :'ws', :'project'), '42501', 'a non-worker cannot open a scan');

-- Save settings (Off first): the scan gate never opens while Off.
reset role;
update contentpilot_private.sports_auto_publish_deliveries set slot = slot + 1000000;
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'off', 20, 4, 3);
select pg_temp.check_mode((select (mode, daily_quota, scan_interval_hours, posts_per_scan) = ('off', 20, 4, 3) from public.get_sports_automation_mode(:'ws', :'project')), 'settings persisted server-side while Off');
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), 'Off: scan is never due');

-- Semi: first scan due, concurrent/second tick not due; interval honoured and changes are safe.
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'semi', 20);  -- NULL keeps 4h / 3
select pg_temp.check_mode((select (scan_interval_hours, posts_per_scan) = (4, 3) from public.get_sports_automation_mode(:'ws', :'project')), 'omitted settings keep stored values');
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = null where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select due and posts_per_scan = 3 and scan_interval_hours = 4 from public.begin_sports_scan(:'ws', :'project')), 'first scan is due and returns the configured limits');
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), 'an immediate second tick is not due (no duplicate scan)');
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = clock_timestamp() - interval '3 hours' where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), '3h after the last scan with a 4h interval: not due');
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'semi', 20, 2, 3);  -- interval shortened to 2h
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select due from public.begin_sports_scan(:'ws', :'project')), 'shortening the interval takes effect on the next tick, measured from the last real scan');
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), 'the shortened interval does not allow a second scan right away');
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = clock_timestamp() - interval '1 hour 55 minutes' where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select due from public.begin_sports_scan(:'ws', :'project')), 'scheduler jitter (<=10 min early) is tolerated');

-- Auto: enforcement of posts-per-scan and in-place edits (no new window, no backlog replay).
select set_config('request.jwt.claim.sub', :'owner', false);
reset role;
select (count(*) + 50) as quota from contentpilot_private.sports_auto_publish_deliveries d
  where (d.started_at at time zone 'Asia/Dubai')::date = (clock_timestamp() at time zone 'Asia/Dubai')::date \gset
update contentpilot_private.sports_auto_publish_deliveries set slot = slot + 1000000;
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota, 2, 1);
reset role;
select id as win_before, starts_at as win_start from contentpilot_private.sports_auto_publish_windows where persistent and ends_at = 'infinity' and project_id = :'project' \gset
select pg_temp.check_mode((select max_per_slot = 1 from contentpilot_private.sports_auto_publish_windows where id = :'win_before'), 'window carries posts-per-scan = 1');
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.draft('https://fn09.example/a') as a \gset
select pg_temp.draft('https://fn09.example/b') as b \gset
select pg_temp.check_mode(pg_temp.claim(:'a') = 1, 'first post of the scan is claimed');
select pg_temp.check_mode(pg_temp.claim(:'b') = 0, 'second post is blocked at posts per scan = 1 (enforced, not a label)');
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota, 2, 2);
reset role;
select pg_temp.check_mode((select count(*) = 1 and bool_and(id = :'win_before' and starts_at = :'win_start' and max_per_slot = 2)
  from contentpilot_private.sports_auto_publish_windows where persistent and ends_at = 'infinity' and project_id = :'project'), 'same-mode Auto edit updates the open window in place (no replay, no new window)');
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode(pg_temp.claim(:'b') = 1, 'raising posts per scan to 2 allows the second post');
select pg_temp.draft('https://fn09.example/c') as c \gset
select pg_temp.check_mode(pg_temp.claim(:'c') = 0, 'a third post in the same slot is blocked at 2');

-- Daily Limit is a hard cap, lowering it takes effect immediately and never replays.
reset role;
update contentpilot_private.sports_auto_publish_deliveries set slot = slot + 1000000;
select count(*) as today from contentpilot_private.sports_auto_publish_deliveries d
  where (d.started_at at time zone 'Asia/Dubai')::date = (clock_timestamp() at time zone 'Asia/Dubai')::date \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', greatest(:today, 1), 2, 2);
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode(pg_temp.claim(:'c') = 0, 'Daily Limit already reached: no further claim even with a fresh slot');
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'off', greatest(:today, 1), 2, 2);
select pg_temp.check_mode((select mode = 'off' and scan_interval_hours = 2 and posts_per_scan = 2 from public.get_sports_automation_mode(:'ws', :'project')), 'Emergency Stop keeps the configured cadence and goes Off');
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode(pg_temp.claim(:'c') = 0 and (select not due from public.begin_sports_scan(:'ws', :'project')), 'Off: nothing claimable, no scan');
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode((select count(*) >= 1 and bool_or(scan_interval_hours = 2 and posts_per_scan = 2) from public.list_sports_automation_events(:'ws', :'project')), 'cadence settings are audited');
reset role;


-- ===== FN09-QC-B: per-scan cap is accounted per stable scan identity, not per interval-derived slot =====
select count(*) + 40 as quota2 from contentpilot_private.sports_auto_publish_deliveries d
  where (d.started_at at time zone 'Asia/Dubai')::date = (clock_timestamp() at time zone 'Asia/Dubai')::date \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota2, 2, 2);
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = null, scan_status = 'done', scan_retries = 0 where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select due and not is_retry from public.begin_sports_scan(:'ws', :'project')), 'QC-B: scan N opens');
reset role;
select scan_seq as seq_n from contentpilot_private.sports_automation_modes where project_id = :'project' \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.draft('https://fn09.example/b1') as b1 \gset
select pg_temp.draft('https://fn09.example/b2') as b2 \gset
select pg_temp.draft('https://fn09.example/b3') as b3 \gset
select pg_temp.draft('https://fn09.example/b4') as b4 \gset
select pg_temp.check_mode(pg_temp.claim(:'b1') = 1 and pg_temp.claim(:'b2') = 1, 'QC-B: two posts claimed in scan N (cap 2)');
-- Interval INCREASED mid-slot (2h -> 6h) then DECREASED (6h -> 2h): neither opens a second allowance.
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota2, 6, 2);
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode(pg_temp.claim(:'b3') = 0, 'QC-B: increasing the interval mid-scan does not allow a 3rd post');
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota2, 4, 2);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota2, 2, 2);
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode(pg_temp.claim(:'b3') = 0, 'QC-B: decreasing the interval mid-scan does not allow a 3rd post');
reset role;
select pg_temp.check_mode((select scan_seq = :seq_n from contentpilot_private.sports_automation_modes where project_id = :'project'), 'QC-B: interval changes never change the scan identity');
select pg_temp.check_mode((select count(*) = 2 from contentpilot_private.sports_auto_publish_deliveries d join contentpilot_private.sports_auto_publish_windows w on w.id = d.window_id where d.slot = :seq_n and w.project_id = :'project'), 'QC-B: exactly 2 deliveries accounted to scan N');
-- Cap lowered then raised: prospective, applies to the open scan, nothing replays by itself.
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota2, 2, 1);
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode(pg_temp.claim(:'b3') = 0, 'QC-B: lowering the cap below what the scan already sent blocks further posts (no rollback of sent ones)');
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota2, 2, 3);
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode(pg_temp.claim(:'b3') = 1, 'QC-B: raising the cap lets the open scan use the extra allowance');
-- Next real scan (new identity) gets a fresh allowance; a premature tick does not.
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), 'QC-B: tick inside the interval opens no new scan');
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = clock_timestamp() - interval '2 hours' where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota2, 2, 2);
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select due and not is_retry from public.begin_sports_scan(:'ws', :'project')), 'QC-B: scan N+1 opens at the interval');
reset role;
select pg_temp.check_mode((select scan_seq = :seq_n + 1 from contentpilot_private.sports_automation_modes where project_id = :'project'), 'QC-B: scan N+1 has a new identity');
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode(pg_temp.claim(:'b4') = 1, 'QC-B: the new scan has its own allowance (not blocked by scan N)');

-- ===== FN09-QC-C: bounded retry of a failed RSS scan =====
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), 'QC-C: scan is claimed, no duplicate tick');
select public.finish_sports_scan(:'ws', :'project', false);
reset role;
select pg_temp.check_mode((select scan_status = 'failed' from contentpilot_private.sports_automation_modes where project_id = :'project'), 'QC-C: failed scan marked failed');
-- interval 6h so only the retry path can make it due
update contentpilot_private.sports_automation_modes set scan_interval_hours = 6 where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), 'QC-C: no tight loop: a failed scan is not retried before one scheduler tick');
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = clock_timestamp() - interval '2 hours' where project_id = :'project';
select scan_seq as seq_f from contentpilot_private.sports_automation_modes where project_id = :'project' \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select due and is_retry from public.begin_sports_scan(:'ws', :'project')), 'QC-C: retry allowed one tick later, inside the 6h interval');
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), 'QC-C: concurrent/second tick cannot double-retry (claim is durable)');
reset role;
select pg_temp.check_mode((select scan_seq = :seq_f and scan_retries = 1 from contentpilot_private.sports_automation_modes where project_id = :'project'), 'QC-C: retry keeps the scan identity (per-scan cap is not doubled)');
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select public.finish_sports_scan(:'ws', :'project', false);
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = clock_timestamp() - interval '2 hours' where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select due and is_retry from public.begin_sports_scan(:'ws', :'project')), 'QC-C: second retry allowed');
select public.finish_sports_scan(:'ws', :'project', false);
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = clock_timestamp() - interval '2 hours' where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), 'QC-C: retries are bounded at 2; then wait for the next regular interval');
-- successful (also empty) scan is never retried
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = clock_timestamp() - interval '7 hours' where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select due and not is_retry from public.begin_sports_scan(:'ws', :'project')), 'QC-C: regular scan after the interval is a fresh scan (retries reset)');
select public.finish_sports_scan(:'ws', :'project', true);
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = clock_timestamp() - interval '2 hours' where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), 'QC-C: a successful (even empty) scan is not retried');
-- Off / Emergency Stop: no retry
reset role;
update contentpilot_private.sports_automation_modes set last_scan_at = clock_timestamp() - interval '7 hours', scan_status = 'claimed' where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select public.finish_sports_scan(:'ws', :'project', false);
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws', :'project', :'channel', 'off', :quota2, 2, 2);
reset role;
select pg_temp.check_mode((select scan_status = 'done' and scan_retries = 0 from contentpilot_private.sports_automation_modes where project_id = :'project'), 'QC-C: Off clears a pending retry');
update contentpilot_private.sports_automation_modes set scan_status = 'failed', last_scan_at = clock_timestamp() - interval '3 hours' where project_id = :'project';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select not due from public.begin_sports_scan(:'ws', :'project')), 'QC-C: no retry while Off');
select set_config('request.jwt.claim.sub', :'outsider', false);
select pg_temp.denied(format('select public.finish_sports_scan(%L,%L,false)', :'ws', :'project'), '42501', 'QC-C: finish_sports_scan is worker-only') ;
reset role;
