\set ON_ERROR_STOP on
-- FN08: Off / Semi / Auto automation modes (reuses the fixtures of 80_sports_news.sql).

create function pg_temp.check_mode(ok boolean, message text) returns void
language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if;
  raise notice 'ok - %', message;
end
$$;
create function pg_temp.denied(stmt text, expected text, message text) returns void
language plpgsql as $$
begin
  execute stmt;
  raise exception 'ASSERTION FAILED: % (statement succeeded)', message;
exception when others then
  if sqlstate <> expected then raise exception 'ASSERTION FAILED: % (got % %)', message, sqlstate, sqlerrm; end if;
  raise notice 'ok - %', message;
end
$$;

\set ws '6c000000-0000-0000-0000-000000000001'
\set project '6c100000-0000-0000-0000-000000000001'
\set worker '00000000-0000-0000-0000-0000000006c3'
\set owner '00000000-0000-0000-0000-0000000006c1'
\set outsider '00000000-0000-0000-0000-0000000006c4'
\set channel '60000000-0000-4000-8000-000000000080'

-- Auto draft fixtures are created through the worker.
create function pg_temp.draft(p_url text, p_key text) returns uuid language sql as $$
  select public.record_sports_news_assessment('6c000000-0000-0000-0000-000000000001', '6c100000-0000-0000-0000-000000000001',
    p_url, encode(sha256(convert_to('fn08' || p_url, 'UTF8')), 'hex'), 9, 'Tin ' || p_url, 'Caption', null, 'Test', array['60000000-0000-4000-8000-000000000080'::uuid],
    jsonb_build_object('publishedAt', clock_timestamp(), 'rubricVersion', 'sports-v1', 'decision', 'threshold_met'))
$$;
grant execute on function pg_temp.draft(text, text) to public;

reset role;
-- Earlier fixtures (80/85) ran as an explicit Semi project; start from an unconfigured project.
delete from contentpilot_private.sports_automation_modes;
-- Existing deployments: no mode row fails safe to Off (never starts RSS/AI/delivery), never Auto.
select pg_temp.check_mode((select count(*) = 0 from contentpilot_private.sports_automation_modes), 'migration creates no mode row (nothing is silently enabled)');
select count(*) as baseline from contentpilot_private.sports_auto_publish_deliveries d
  join contentpilot_private.sports_auto_publish_windows w on w.id = d.window_id
  where (d.started_at at time zone 'Asia/Dubai')::date = (clock_timestamp() at time zone 'Asia/Dubai')::date \gset

set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select mode = 'off' and version = 0 from public.get_sports_automation_mode(:'ws', :'project')), 'absent row reads as Off (fail safe)');
select pg_temp.denied(format('select pg_temp.draft(%L,%L)', 'https://tuoitre.vn/m-absent.htm', repeat('9', 64)), 'CP411', 'unconfigured project rejects new drafts');
select pg_temp.check_mode((select count(*) = 0 from public.claim_social_deliveries(:'ws', array[:'channel'::uuid])), 'unconfigured project claims no deliveries');
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''auto'',5)', :'ws', :'project', :'channel'), '42501', 'a Member cannot change the mode');
select set_config('request.jwt.claim.sub', :'outsider', false);
select pg_temp.denied(format('select public.get_sports_automation_mode(%L,%L)', :'ws', :'project'), '42501', 'a non-member cannot read the mode');
select pg_temp.denied(format('select public.list_sports_automation_events(%L,%L)', :'ws', :'project'), '42501', 'a non-member cannot read the audit log');
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''off'',5)', :'ws', :'project', :'channel'), '42501', 'a non-member cannot change the mode');

select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''bogus'',5)', :'ws', :'project', :'channel'), '22023', 'invalid mode is rejected');
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''auto'',0)', :'ws', :'project', :'channel'), '22023', 'daily quota below 1 is rejected');
select pg_temp.denied(format('select public.set_sports_automation_mode(%L,%L,%L,''auto'',121)', :'ws', :'project', :'channel'), '22023', 'daily quota above 120 is rejected');
reset role;
-- Earlier fixtures may have used the current 2h slot: move them out of the current slot (the per-slot cap is 3).
update contentpilot_private.sports_auto_publish_deliveries set slot = slot + 1000000;
select (:baseline + 2) as quota \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode(public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota) = 1, 'Owner enables persistent Auto (version 1)');
select pg_temp.check_mode((select max_per_slot = 2 and persistent from public.read_sports_auto_publish_control(:'ws', :'project', :'channel')), 'Auto outputs at most 2 posts per 2h slot by default (FN09)');
select pg_temp.check_mode((select persistent and ends_at is null and max_per_day = :quota from public.read_sports_auto_publish_control(:'ws', :'project', :'channel')), 'Auto has no expiry and exposes the daily quota');

select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select count(*) = 1 from public.get_sports_auto_publish_window(:'ws', :'project', :'channel')), 'worker sees the persistent window');
select pg_temp.draft('https://tuoitre.vn/m-a.htm', repeat('1', 64)) as m_a \gset
select pg_temp.draft('https://tuoitre.vn/m-b.htm', repeat('2', 64)) as m_b \gset
select pg_temp.draft('https://tuoitre.vn/m-c.htm', repeat('3', 64)) as m_c \gset
select pg_temp.check_mode((select count(*) = 1 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'m_a') where persistent and ends_at is null), 'Auto claims the first post');
select pg_temp.check_mode((select count(*) = 1 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'m_b')), 'Auto claims the second post');
select pg_temp.check_mode((select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'m_a')), 'a claimed post is never claimed twice (idempotency)');
select pg_temp.check_mode((select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'m_c')), 'the daily quota blocks the next post');

-- Semi: window closed, nothing is auto-delivered, drafts still wait for a human.
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode(public.set_sports_automation_mode(:'ws', :'project', :'channel', 'semi', :quota) = 2, 'Owner switches to Semi');
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select count(*) = 0 from public.get_sports_auto_publish_window(:'ws', :'project', :'channel')), 'Semi closes the persistent window');
select pg_temp.check_mode((select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'m_c')), 'Semi never auto-claims');
select pg_temp.check_mode((select status = 'pending' from public.content_publish_requests where post_id = :'m_c'), 'the Semi draft stays pending human approval');
select set_config('request.jwt.claim.sub', :'owner', false);

-- Auto again: no backlog replay; unresolved/follow-up/reconsidered/uncertain posts are allowed.
reset role;
update contentpilot_private.sports_auto_publish_deliveries set slot = slot + 1000000;
select (count(*) + 2) as quota2 from contentpilot_private.sports_auto_publish_deliveries d
  where (d.started_at at time zone 'Asia/Dubai')::date = (clock_timestamp() at time zone 'Asia/Dubai')::date \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode(public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota2) = 3, 'Owner re-enables Auto with a new quota');
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'m_c')), 'no automatic backlog replay: a pre-switch draft is not delivered');
select pg_temp.draft('https://tuoitre.vn/m-d.htm', repeat('4', 64)) as m_d \gset
select pg_temp.draft('https://tuoitre.vn/m-e.htm', repeat('5', 64)) as m_e \gset
select pg_temp.draft('https://tuoitre.vn/m-f.htm', repeat('6', 64)) as m_f \gset
reset role;
update public.sports_news_items set manual_review_reason = 'unresolved_identity' where post_id = :'m_d';
update public.sports_news_items set manual_review_reason = 'follow_up' where post_id = :'m_e';
update public.sports_news_items set manual_review_reason = 'reconsidered' where post_id = :'m_f';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select count(*) = 1 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'m_d')), 'Auto permits unresolved_identity without manual approval');
select pg_temp.check_mode((select count(*) = 1 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'m_e')), 'Auto permits follow_up without manual approval');
select pg_temp.check_mode((select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'m_f')), 'the daily quota still applies across windows');

-- Off: stops drafts, window reads and claims at the database.
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode(public.set_sports_automation_mode(:'ws', :'project', :'channel', 'off', :quota2) = 4, 'Owner switches Off');
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select mode = 'off' from public.get_sports_automation_mode(:'ws', :'project')), 'worker reads Off');
select pg_temp.check_mode((select count(*) = 0 from public.get_sports_auto_publish_window(:'ws', :'project', :'channel')), 'Off exposes no window');
select pg_temp.check_mode((select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'m_f')), 'Off blocks auto delivery claims');
select pg_temp.denied(format('select pg_temp.draft(%L,%L)', 'https://tuoitre.vn/m-g.htm', repeat('7', 64)), 'CP411', 'Off rejects new drafts in the database');
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.denied(format('select public.set_sports_auto_publish_control(%L,%L,%L,true,2,3,6)', :'ws', :'project', :'channel'), '22023', 'legacy temporary window cannot be started while Off');
select pg_temp.check_mode(public.set_sports_automation_mode(:'ws', :'project', :'channel', 'semi', :quota2) = 5, 'Off -> Semi resumes scanning');
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode(pg_temp.draft('https://tuoitre.vn/m-g.htm', repeat('7', 64)) is not null, 'Semi stores drafts again');

-- Audit trail.
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode((select count(*) = 5 and (array_agg(to_mode order by created_at))[1] = 'auto' from public.list_sports_automation_events(:'ws', :'project')), 'every transition is audited');
reset role;
select pg_temp.check_mode((select count(*) = 1 from contentpilot_private.sports_auto_publish_windows where persistent and ends_at = 'infinity') = false, 'no open persistent window remains after Semi');
select pg_temp.check_mode(not has_table_privilege('authenticated', 'contentpilot_private.sports_automation_modes', 'select'), 'mode table is not directly readable');
select pg_temp.check_mode(not has_function_privilege('anon', 'public.set_sports_automation_mode(uuid,uuid,uuid,text,integer,integer,integer)', 'EXECUTE'), 'anon cannot set modes');

-- Slot cap (3 per 2h slot) and Emergency Stop => Off, with quota not silently altered.
update contentpilot_private.sports_auto_publish_deliveries set slot = slot + 1000000;
select (count(*) + 50) as quota3 from contentpilot_private.sports_auto_publish_deliveries d
  where (d.started_at at time zone 'Asia/Dubai')::date = (clock_timestamp() at time zone 'Asia/Dubai')::date \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode(public.set_sports_automation_mode(:'ws', :'project', :'channel', 'auto', :quota3, 2, 3) = 6, 'Owner enables Auto with 3 posts per scan for the slot cap test');
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.draft('https://tuoitre.vn/s-1.htm', repeat('a', 64)) as s_1 \gset
select pg_temp.draft('https://tuoitre.vn/s-2.htm', repeat('b', 64)) as s_2 \gset
select pg_temp.draft('https://tuoitre.vn/s-3.htm', repeat('c', 64)) as s_3 \gset
select pg_temp.draft('https://tuoitre.vn/s-4.htm', repeat('d', 64)) as s_4 \gset
select pg_temp.check_mode((select count(*) = 1 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'s_1')), 'slot post 1 is claimed');
select pg_temp.check_mode((select count(*) = 1 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'s_2')), 'slot post 2 is claimed');
select pg_temp.check_mode((select count(*) = 1 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'s_3')), 'slot post 3 is claimed');
select pg_temp.check_mode((select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'s_4')), 'the 4th post of one slot is blocked (posts per scan = 3)');
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_mode(public.set_sports_automation_mode(:'ws', :'project', :'channel', 'off', :quota3) = 7, 'Emergency Stop switches to Off');
select pg_temp.check_mode((select mode = 'off' and daily_quota = :quota3 from public.get_sports_automation_mode(:'ws', :'project')), 'Emergency Stop keeps the daily quota unchanged');
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_mode((select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'s_4')), 'after Emergency Stop nothing is claimed');
reset role;
