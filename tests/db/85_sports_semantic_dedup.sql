\set ON_ERROR_STOP on
-- FN05: semantic event deduplication (reuses the workspace/project/worker fixtures of 80_sports_news.sql).

create function pg_temp.check_event(ok boolean, message text) returns void
language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if;
  raise notice 'ok - %', message;
end
$$;

\set ws '6c000000-0000-0000-0000-000000000001'
\set project '6c100000-0000-0000-0000-000000000001'
\set worker '00000000-0000-0000-0000-0000000006c3'
\set owner '00000000-0000-0000-0000-0000000006c1'
\set outsider '00000000-0000-0000-0000-0000000006c4'
\set ws2 '6c000000-0000-0000-0000-00000000000a'
\set project2 '6c100000-0000-0000-0000-00000000000a'
\set worker2 '00000000-0000-0000-0000-0000000006c5'
\set channel '60000000-0000-4000-8000-000000000080'

-- A second, isolated workspace with its own project and registered worker.
insert into auth.users (id, email) values (:'worker2', 'dest-worker2@example.test');
set role authenticated;
select set_config('request.jwt.claim.sub', :'outsider', false);
insert into public.workspaces (id, name) values (:'ws2', 'Workspace 2');
insert into public.content_projects (id, workspace_id, name) values (:'project2', :'ws2', 'Blog 2');
insert into public.workspace_members (workspace_id, user_id, role) values (:'ws2', :'worker2', 'member');
reset role;
insert into contentpilot_private.sports_news_workers values (:'ws2', :'worker2');

\set event_a '{"decision":"new","specific":true,"eventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","identity":{"version":"event-v1","type":"match_result"},"reasons":[{"code":"no_matching_event"}]}'
\set event_dup_cluster '{"decision":"new","specific":true,"eventKey":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","identity":{"version":"event-v1"},"reasons":[]}'
\set event_follow '{"decision":"follow_up","specific":true,"matchedEventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","eventKey":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","identity":{"version":"event-v1","status":"official"},"reasons":[{"code":"status_upgraded","detail":"rumor->official"}],"evidence":{"matchedTitle":"Tin đồn"}}'
\set event_orphan '{"decision":"follow_up","specific":true,"matchedEventKey":"9999999999999999999999999999999999999999999999999999999999999999","eventKey":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","identity":{"version":"event-v1"},"reasons":[]}'

set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);

select public.record_sports_news_event_assessment(:'ws', :'project', 'https://tuoitre.vn/event-a.htm', repeat('1',64),
  8, 'Sự kiện A', 'Caption', null, 'RSS', array[:'channel'::uuid], '{"decision":"threshold_met"}'::jsonb, :'event_a'::jsonb) as event_post \gset
select pg_temp.check_event(:'event_post' is not null
  and (select event_key = repeat('a',64) and cluster_key = repeat('c',64) and event_identity->>'type' = 'match_result'
       from public.sports_news_items where post_id = :'event_post'),
  'a new event is recorded with its identity');

-- Same event reported by a second source with a different URL AND headline: only semantics can catch it.
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws', :'project', 'https://thanhnien.vn/event-a.htm',
  repeat('2',64), 8, 'Tiêu đề khác', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, :'event_a'::jsonb) is null,
  'the same event key from another source is rejected');
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws', :'project', 'https://vnexpress.net/event-a.htm',
  repeat('3',64), 8, 'Tiêu đề khác nữa', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, :'event_dup_cluster'::jsonb) is null,
  'a differently-keyed report in the same event cluster is rejected by the database recheck');
select pg_temp.check_event(
  (select count(*) = 1 from public.sports_news_items where project_id = :'project' and cluster_key = repeat('c',64))
  and (select count(*) = 1 from public.content_posts where title = 'Sự kiện A')
  and not exists (select 1 from public.sports_news_items where source_url in ('https://thanhnien.vn/event-a.htm', 'https://vnexpress.net/event-a.htm')),
  'rejected duplicates create no item and no post');
select pg_temp.check_event(
  (select count(*) = 2 and bool_and(decision = 'duplicate')
     and bool_or(reasons->0->>'code' = 'same_event_key') and bool_or(reasons->0->>'code' = 'same_event_cluster')
   from public.sports_news_event_matches where project_id = :'project'),
  'structured reasons are retained for each rejected duplicate');

-- Meaningful follow-up of an existing event is accepted and linked to its parent.
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://tuoitre.vn/event-a-official.htm', repeat('4',64),
  8, 'Chính thức', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, :'event_follow'::jsonb) as follow_post \gset
select pg_temp.check_event(:'follow_post' is not null
  and (select count(*) = 1 from public.sports_news_event_matches
       where decision = 'follow_up' and matched_event_key = repeat('a',64) and reasons->0->>'code' = 'status_upgraded'
         and evidence->>'matchedTitle' = 'Tin đồn'),
  'a meaningful follow-up is accepted and its evidence retained');
-- A follow-up that names a parent which does not exist cannot bypass the cluster check.
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws', :'project', 'https://tuoitre.vn/orphan.htm', repeat('5',64),
  8, 'Mồ côi', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, :'event_orphan'::jsonb) is null,
  'a follow-up claiming a nonexistent parent is treated as a duplicate');

-- URL/headline dedup is preserved: same URL with a brand-new event key creates nothing.
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws', :'project', 'https://tuoitre.vn/event-a.htm', repeat('6',64),
  8, 'Trùng URL', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb,
  jsonb_set(jsonb_set(:'event_a'::jsonb, '{eventKey}', to_jsonb(repeat('7',64))), '{clusterKey}', to_jsonb(repeat('8',64)))) is null
  and (select event_key = repeat('a',64) from public.sports_news_items where source_url = 'https://tuoitre.vn/event-a.htm'),
  'URL deduplication still wins and never restamps an existing item');
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws', :'project', 'https://x.vn/headline.htm', repeat('1',64),
  8, 'Trùng tiêu đề', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb,
  jsonb_set(jsonb_set(:'event_a'::jsonb, '{eventKey}', to_jsonb(repeat('7',64))), '{clusterKey}', to_jsonb(repeat('8',64)))) is null,
  'headline deduplication still wins');

-- Skipped duplicates are recorded idempotently.
select pg_temp.check_event(public.record_sports_news_event_duplicate(:'ws', :'project', 'https://skip.vn/a.htm', repeat('9',64),
  '{"decision":"new","specific":true,"eventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","matchedEventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reasons":[{"code":"participants_overlap"}],"evidence":{"matchedUrl":"https://tuoitre.vn/event-a.htm"}}'::jsonb),
  'a pre-filtered duplicate is recorded with its evidence');
select pg_temp.check_event(not public.record_sports_news_event_duplicate(:'ws', :'project', 'https://skip.vn/a.htm', repeat('9',64),
  '{"decision":"new","specific":true,"eventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","reasons":[]}'::jsonb),
  'recording the same skipped duplicate twice is idempotent');

-- Invalid payloads and unauthorized callers.
select set_config('contentpilot.ws', :'ws', false);
select set_config('contentpilot.project', :'project', false);
select set_config('contentpilot.event_a', :'event_a', false);
do $$
begin
  perform public.record_sports_news_event_assessment(current_setting('contentpilot.ws')::uuid,
    current_setting('contentpilot.project')::uuid, 'https://bad.vn/1', repeat('b',64), 8, null, null, null, null,
    array[]::uuid[], '{}'::jsonb, '{"eventKey":"nope"}'::jsonb);
  raise exception 'invalid event accepted';
exception when invalid_parameter_value then null;
end $$;
select pg_temp.check_event(true, 'a malformed event payload is rejected');

-- Cross-workspace: worker of workspace 1 cannot write workspace 2; the same event is independent there.
do $$
begin
  perform public.record_sports_news_event_assessment('6c000000-0000-0000-0000-00000000000a'::uuid,
    '6c100000-0000-0000-0000-00000000000a'::uuid, 'https://x.vn/cross', repeat('b',64), 8, null, null, null, null,
    array[]::uuid[], '{}'::jsonb, current_setting('contentpilot.event_a')::jsonb);
  raise exception 'cross-workspace write permitted';
exception when insufficient_privilege then null;
end $$;
select pg_temp.check_event(true, 'a worker cannot record events in another workspace');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'worker2', false);
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws2', :'project2', 'https://tuoitre.vn/event-a.htm', repeat('1',64),
  8, 'Sự kiện A', 'Caption', null, 'RSS', array[]::uuid[], '{}'::jsonb, :'event_a'::jsonb) is not null,
  'identical events in another workspace are not deduplicated against this one');
select pg_temp.check_event((select count(*) = 0 from public.sports_news_event_matches where workspace_id = :'ws'),
  'event evidence is invisible to another workspace');
select pg_temp.check_event((select count(*) = 0 from public.sports_news_items where workspace_id = :'ws'),
  'event identities are invisible to another workspace');

-- Workspace members can read evidence, and no client can write it directly.
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_event((select count(*) >= 3 from public.sports_news_event_matches where project_id = :'project'),
  'workspace members can read retained event evidence');
select set_config('contentpilot.ws', :'ws', false);
do $$
begin
  insert into public.sports_news_event_matches (workspace_id, project_id, source_url, headline_key, decision, event_key, reasons, evidence)
  values (current_setting('contentpilot.ws')::uuid, '6c100000-0000-0000-0000-000000000001', 'x', repeat('a',64), 'duplicate', repeat('a',64), '[]', '{}');
  raise exception 'direct evidence insert permitted';
exception when insufficient_privilege then null;
end $$;
select pg_temp.check_event(true, 'event evidence cannot be written directly by clients');
reset role;

-- Exact ACLs of the two FN05 RPCs: only `authenticated` may execute them (anon/public/service_role may not),
-- and execution alone grants nothing: authorization is the registered-worker check inside the function.
select pg_temp.check_event(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   and not has_function_privilege('anon', p.oid, 'EXECUTE')
                   and not has_function_privilege('service_role', p.oid, 'EXECUTE')
                   and not has_function_privilege('public', p.oid, 'EXECUTE')
                   and p.prosecdef and 'search_path=""' = any (p.proconfig)) and count(*) = 2
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('record_sports_news_event_assessment', 'record_sports_news_event_duplicate')),
  'FN05 RPC ACLs: authenticated only, security definer, pinned search_path');

-- anon cannot call them at all.
set role anon;
do $$
begin
  perform public.record_sports_news_event_duplicate('6c000000-0000-0000-0000-000000000001'::uuid,
    '6c100000-0000-0000-0000-000000000001'::uuid, 'https://anon.vn/1', repeat('a',64),
    '{"decision":"new","specific":true,"eventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","reasons":[]}'::jsonb);
  raise exception 'anon call permitted';
exception when insufficient_privilege then null;
end $$;
reset role;
select pg_temp.check_event(true, 'anon cannot execute the FN05 RPCs');

-- A signed-in workspace member who is not the registered worker, and a signed-in outsider, are both refused.
select set_config('contentpilot.ws', :'ws', false);
select set_config('contentpilot.project', :'project', false);
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
do $$
begin
  perform public.record_sports_news_event_assessment(current_setting('contentpilot.ws')::uuid,
    current_setting('contentpilot.project')::uuid, 'https://member.vn/1', repeat('c',64), 8, null, null, null, null,
    array[]::uuid[], '{}'::jsonb, '{"decision":"new","specific":true,"eventKey":"1111111111111111111111111111111111111111111111111111111111111111","clusterKey":"2222222222222222222222222222222222222222222222222222222222222222","reasons":[]}'::jsonb);
  raise exception 'non-worker member permitted';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform public.record_sports_news_event_duplicate(current_setting('contentpilot.ws')::uuid,
    current_setting('contentpilot.project')::uuid, 'https://member.vn/2', repeat('d',64),
    '{"decision":"new","specific":true,"eventKey":"1111111111111111111111111111111111111111111111111111111111111111","clusterKey":"2222222222222222222222222222222222222222222222222222222222222222","reasons":[]}'::jsonb);
  raise exception 'non-worker member permitted';
exception when insufficient_privilege then null;
end $$;
select set_config('request.jwt.claim.sub', :'outsider', false);
do $$
begin
  perform public.record_sports_news_event_duplicate(current_setting('contentpilot.ws')::uuid,
    current_setting('contentpilot.project')::uuid, 'https://outsider.vn/1', repeat('e',64),
    '{"decision":"new","specific":true,"eventKey":"1111111111111111111111111111111111111111111111111111111111111111","clusterKey":"2222222222222222222222222222222222222222222222222222222222222222","reasons":[]}'::jsonb);
  raise exception 'outsider permitted';
exception when insufficient_privilege then null;
end $$;
reset role;
select pg_temp.check_event(
  not exists (select 1 from public.sports_news_event_matches where source_url like 'https://member.vn/%' or source_url like 'https://outsider.vn/%'
              or source_url like 'https://anon.vn/%'),
  'refused callers leave no event evidence behind');

-- Cross-workspace project id: the worker of workspace 2 naming workspace 1's project is rejected (pair mismatch).
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker2', false);
do $$
begin
  perform public.record_sports_news_event_duplicate('6c000000-0000-0000-0000-00000000000a'::uuid,
    '6c100000-0000-0000-0000-000000000001'::uuid, 'https://cross.vn/1', repeat('f',64),
    '{"decision":"new","specific":true,"eventKey":"1111111111111111111111111111111111111111111111111111111111111111","clusterKey":"2222222222222222222222222222222222222222222222222222222222222222","reasons":[]}'::jsonb);
  raise exception 'cross-workspace project permitted';
exception when invalid_parameter_value then null;
end $$;
reset role;
select pg_temp.check_event(true, 'a worker cannot target another workspace''s project through its own workspace id');

-- ===========================================================================================================
-- FN05 QC remediation: only an actual, eligible post may block; sparse identities fail open.
-- ===========================================================================================================
create function pg_temp.ev(k text, c text, decision text default 'new', specific boolean default true, parent text default null)
returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'decision', decision, 'specific', specific, 'eventKey', repeat(k, 64), 'clusterKey', repeat(c, 64),
    'matchedEventKey', case when parent is null then null else repeat(parent, 64) end,
    'identity', jsonb_build_object('version', 'event-v2', 'subjectKind', 'match'),
    'reasons', case when decision = 'follow_up' then '[{"code":"score_changed"}]'::jsonb else '[]'::jsonb end,
    'evidence', jsonb_build_object('matchedTitle', 'x')))
$$;
\set ws_post_before '0'

set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);

-- (1) low -> high: a low-score item (no post) of an event never blocks a later, stronger report.
-- (Checks read in a separate statement: a statement cannot see rows written by its own function calls.)
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://low.vn/1', repeat('a1',32),
  2, null, null, null, null, array[]::uuid[], '{"decision":"below_threshold"}'::jsonb, pg_temp.ev('1', '2')) is null as low1_null \gset
select pg_temp.check_event(:'low1_null'
  and exists (select 1 from public.sports_news_items where source_url = 'https://low.vn/1' and post_id is null and event_key = repeat('1',64)),
  'a low-score report is recorded as an item without a post');
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://high.vn/1', repeat('a2',32),
  8, 'Báo cáo mạnh', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev('3', '2')) as high_post \gset
select pg_temp.check_event(:'high_post' is not null,
  'a stronger report with a different key in the same cluster is accepted after a low-score one');
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws', :'project', 'https://high.vn/2', repeat('a3',32),
  8, 'Báo cáo mạnh khác', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev('4', '2')) is null,
  'once the post exists, another materializing report of the cluster is rejected');
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://low.vn/2', repeat('a4',32),
  2, null, null, null, null, array[]::uuid[], '{}'::jsonb, pg_temp.ev('5', '2')) is null as low2_null \gset
select pg_temp.check_event(:'low2_null'
  and exists (select 1 from public.sports_news_items where source_url = 'https://low.vn/2' and post_id is null),
  'a low-score report never creates a post and is never rejected semantically');

-- (2) sparse / ambiguous identity (specific=false) fails open to normal handling and stores no keys.
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://vague.vn/1', repeat('a5',32),
  8, 'Tin mơ hồ', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev('6', '2', 'new', false)) is not null as vague1 \gset
select pg_temp.check_event(:'vague1'
  and (select event_key is null and cluster_key is null and event_identity is not null
       from public.sports_news_items where source_url = 'https://vague.vn/1'),
  'a non-specific identity is never blocked by a cluster and stores no event keys');
select pg_temp.check_event(
  public.record_sports_news_event_assessment(:'ws', :'project', 'https://vague.vn/2', repeat('a6',32),
    8, 'Tin mơ hồ 2', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev('6', '2', 'new', false)) is not null,
  'a second non-specific report with identical placeholder keys is also not blocked');
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws', :'project', 'https://vague.vn/3', repeat('a7',32),
  8, 'Thiếu cờ specific', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb,
  pg_temp.ev('6', '2') - 'specific') is not null,
  'a payload without the specific flag defaults to fail-open');

-- (3) follow-up whose parent exists only as a low-score item: accepted as new, parent not verified.
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://fu.vn/1', repeat('a8',32),
  8, 'Follow-up mồ côi', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb,
  pg_temp.ev('8', '9', 'follow_up', true, '1')) is not null as fu1 \gset
select pg_temp.check_event(:'fu1'
  and (select (evidence->>'parentVerifiedInDatabase')::boolean = false from public.sports_news_event_matches
       where source_url = 'https://fu.vn/1' and decision = 'follow_up'),
  'a follow-up of a non-materialized parent is accepted and its evidence says the parent was not verified');
-- a genuine follow-up of the accepted post keeps working
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://fu.vn/2', repeat('a9',32),
  8, 'Follow-up thật', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb,
  pg_temp.ev('b', '2', 'follow_up', true, '3')) is not null as fu2 \gset
select pg_temp.check_event(:'fu2'
  and (select (evidence->>'parentVerifiedInDatabase')::boolean from public.sports_news_event_matches
       where source_url = 'https://fu.vn/2' and decision = 'follow_up'),
  'a meaningful follow-up of an accepted post is accepted with a verified parent');
reset role;

-- (4) archived posts stop blocking; (5) posts whose approval requests were all rejected stop blocking.
update public.content_posts set archived_at = now() where id = :'high_post';
select pg_temp.check_event(
  contentpilot_private.sports_item_blocks_event(:'ws', :'high_post') is not true, 'an archived post does not block');
update public.content_posts set archived_at = null where id = :'high_post';
select pg_temp.check_event(contentpilot_private.sports_item_blocks_event(:'ws', :'high_post'),
  'a restored post blocks again (its request was cancelled by archiving, not rejected)');
-- A separate cluster whose only approval request is REJECTED by a human: the event may be reported again.
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://rej.vn/1', repeat('c1',32),
  8, 'Bị từ chối', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev('c', 'd')) as rej_post \gset
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws', :'project', 'https://rej.vn/2', repeat('c2',32),
  8, 'Báo cáo thứ hai', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev('e', 'd')) is null,
  'while the first post is pending approval a same-cluster report is rejected');
select set_config('request.jwt.claim.sub', :'owner', false);
select id as rej_request from public.content_publish_requests where post_id = :'rej_post' \gset
select status from public.reject_publish_request(:'rej_request', 'Không đăng');
select set_config('request.jwt.claim.sub', :'worker', false);
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://rej.vn/3', repeat('c3',32),
  8, 'Báo cáo sau khi bị từ chối', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev('f', 'd')) as after_reject \gset
select pg_temp.check_event(:'after_reject' is not null,
  'after every approval request of a post was rejected, a later report of the event is accepted');
reset role;
select pg_temp.check_event(not contentpilot_private.sports_item_blocks_event(:'ws', :'rej_post'),
  'a post whose approval requests were all rejected does not block');
select pg_temp.check_event(not contentpilot_private.sports_item_blocks_event(:'ws', null), 'no post means no block');

-- (6) workspace isolation: the helper and the recheck only see their own workspace; ws2 is unaffected.
select pg_temp.check_event(not contentpilot_private.sports_item_blocks_event(:'ws2', :'high_post'),
  'a post of another workspace is never considered blocking');

-- (7) the helper is not callable by clients.
select pg_temp.check_event(
  not has_function_privilege('authenticated', 'contentpilot_private.sports_item_blocks_event(uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'contentpilot_private.sports_item_blocks_event(uuid, uuid)', 'EXECUTE')
  and not has_schema_privilege('authenticated', 'contentpilot_private', 'USAGE'),
  'the blocking helper is private: no client can execute it');

-- ===========================================================================================================
-- FN05 acceptance QC: published/delivered posts keep blocking after archive; manual-review-only guard.
-- ===========================================================================================================
create function pg_temp.ev2(k text, c text, decision text default 'new', specific boolean default true, parent text default null)
returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'decision', decision, 'specific', specific, 'eventKey', md5(k) || md5(k), 'clusterKey', md5(c) || md5(c),
    'matchedEventKey', case when parent is null then null else md5(parent) || md5(parent) end,
    'identity', jsonb_build_object('version', 'event-v3', 'subjectKind', 'match'),
    'reasons', case when decision = 'follow_up' then '[{"code":"new_material_facts"}]'::jsonb else '[]'::jsonb end,
    'evidence', jsonb_build_object('matchedTitle', 'x')))
$$;
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://pub.vn/1', repeat('d1',32),
  8, 'Đã đăng', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev2('d', 'e')) as pub_post \gset
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://dlv.vn/1', repeat('d2',32),
  8, 'Đã giao', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev2('1d', '2e')) as dlv_post \gset
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://uns.vn/1', repeat('d3',32),
  8, 'Chưa gửi', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev2('3d', '4e')) as uns_post \gset
select pg_temp.check_event(:'pub_post' is not null and :'dlv_post' is not null and :'uns_post' is not null, 'fixtures for blocking states are created');

-- A genuinely approved + queued delivery (real approval path) for dlv_post.
select set_config('request.jwt.claim.sub', :'owner', false);
select id as dlv_request from public.content_publish_requests where post_id = :'dlv_post' \gset
select status from public.approve_publish_request(:'dlv_request', 1, :'channel');
reset role;

-- published post (status published) and an archived copy of each state
set session_replication_role = replica;
update public.content_posts set status = 'published', published_at = now(), archived_at = now() where id = :'pub_post';
update public.content_posts set archived_at = now() where id in (:'dlv_post', :'uns_post');
set session_replication_role = origin;
select pg_temp.check_event(contentpilot_private.sports_item_blocks_event(:'ws', :'pub_post'),
  'a PUBLISHED post still blocks after it is archived');
select pg_temp.check_event(contentpilot_private.sports_item_blocks_event(:'ws', :'dlv_post'),
  'a post with an approved queued/sending/succeeded delivery still blocks after it is archived');
select pg_temp.check_event(not contentpilot_private.sports_item_blocks_event(:'ws', :'uns_post'),
  'an archived post that was never sent does not block (manual reconsideration)');

-- temporary auto-publish ledger: sending/succeeded/uncertain block an archived post, failed does not.
select id as auto_window from contentpilot_private.sports_auto_publish_windows where project_id = :'project' limit 1 \gset
select id as uns_request from public.content_publish_requests where post_id = :'uns_post' \gset
insert into contentpilot_private.sports_auto_publish_deliveries(window_id, request_id, slot, state)
values (:'auto_window', :'uns_request', 3, 'failed');
select pg_temp.check_event(not contentpilot_private.sports_item_blocks_event(:'ws', :'uns_post'),
  'a failed automatic delivery of an archived post does not block');
update contentpilot_private.sports_auto_publish_deliveries set state = 'uncertain' where request_id = :'uns_request';
select pg_temp.check_event(contentpilot_private.sports_item_blocks_event(:'ws', :'uns_post'),
  'an uncertain automatic delivery blocks even after the post is archived (no duplicate delivery)');
update contentpilot_private.sports_auto_publish_deliveries set state = 'succeeded' where request_id = :'uns_request';
select pg_temp.check_event(contentpilot_private.sports_item_blocks_event(:'ws', :'uns_post'),
  'a succeeded automatic delivery blocks an archived post');

-- the recheck uses it: a later report of the published+archived event is rejected with evidence
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws', :'project', 'https://pub.vn/2', repeat('d4',32),
  9, 'Báo cáo sau khi đã đăng', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev2('5d', 'e')) is null,
  'the database rejects a duplicate of a published event even though the post is archived');
select pg_temp.check_event(public.record_sports_news_event_assessment(:'ws', :'project', 'https://dlv.vn/2', repeat('d5',32),
  9, 'Báo cáo sau giao', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev2('6d', '2e')) is null,
  'the database rejects a duplicate of a delivered event even though the post is archived');
-- a reconsidered (archived, never sent) event is accepted but stamped manual-review-only
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://uns.vn/2', repeat('d6',32),
  9, 'Xem xét lại', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev2('7d', '4e')) is null as recon_null \gset
reset role;
-- uns_post's ledger row is 'succeeded' now: reset it to prove the non-delivered archived case reconsiders
select pg_temp.check_event(:'recon_null', 'sanity: a succeeded automatic delivery also rejects the later report');
delete from contentpilot_private.sports_auto_publish_deliveries where request_id = :'uns_request';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://uns.vn/3', repeat('d7',32),
  9, 'Xem xét lại', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev2('8d', '4e')) as recon_post2 \gset
reset role;
select pg_temp.check_event(:'recon_post2' is not null
  and (select manual_review_reason = 'reconsidered' from public.sports_news_items where post_id = :'recon_post2'),
  'a reconsidered archived/never-sent event is accepted and stamped manual-review-only (reconsidered)');

-- manual_review_reason derivation: unresolved, follow-up, regular, forged
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://mr.vn/1', repeat('e1',32),
  8, 'Mơ hồ', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev2('9d', 'ad', 'new', false)) as mr_unres \gset
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://mr.vn/2', repeat('e2',32),
  8, 'Theo dõi', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev2('ad', 'bd', 'follow_up', true, '1')) as mr_follow \gset
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://mr.vn/3', repeat('e3',32),
  8, 'Thường', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb, pg_temp.ev2('bd', 'cd')) as mr_regular \gset
select public.record_sports_news_event_assessment(:'ws', :'project', 'https://mr.vn/4', repeat('e4',32),
  8, 'Sự thật không chắc', 'Caption', null, 'RSS', array[:'channel'::uuid], '{}'::jsonb,
  pg_temp.ev2('cd', 'dd') || '{"manualReviewReason":"uncertain_facts"}'::jsonb) as mr_uncertain \gset
reset role;
select pg_temp.check_event(
  (select manual_review_reason from public.sports_news_items where post_id = :'mr_unres') = 'unresolved_identity'
  and (select manual_review_reason from public.sports_news_items where post_id = :'mr_follow') = 'follow_up'
  and (select manual_review_reason from public.sports_news_items where post_id = :'mr_regular') is null
  and (select manual_review_reason from public.sports_news_items where post_id = :'mr_uncertain') = 'uncertain_facts',
  'manual_review_reason is derived/stored for unresolved, follow-up and uncertain facts and null for a regular item');
do $$
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000006c3', false);
  set local role authenticated;
  perform public.record_sports_news_event_assessment('6c000000-0000-0000-0000-000000000001'::uuid,
    '6c100000-0000-0000-0000-000000000001'::uuid, 'https://mr.vn/bad', repeat('e5',32), 8, 'Xấu', 'Caption', null, 'RSS',
    array[]::uuid[], '{}'::jsonb,
    jsonb_build_object('decision','new','specific',true,'eventKey',repeat('1',64),'clusterKey',repeat('2',64),
      'manualReviewReason','bogus','identity','{}'::jsonb,'reasons','[]'::jsonb));
  raise exception 'bogus manual reason permitted';
exception when invalid_parameter_value then null;
end $$;
reset role;
select pg_temp.check_event(true, 'an unknown manualReviewReason is rejected');

-- DB guard: the temporary auto-publish claim refuses manual-review-only items; a regular item still claims.
delete from contentpilot_private.sports_auto_publish_deliveries;
update contentpilot_private.sports_auto_publish_windows set starts_at = clock_timestamp() - interval '1 minute',
  ends_at = clock_timestamp() + interval '7 hours', max_per_slot = 10, max_per_window = 40
 where id = :'auto_window';
update public.sports_news_items set assessment = coalesce(assessment, '{}'::jsonb)
  || jsonb_build_object('publishedAt', clock_timestamp(), 'rubricVersion', 'sports-v1', 'decision', 'threshold_met'),
  created_at = clock_timestamp()
 where post_id in (:'mr_unres', :'mr_follow', :'mr_regular', :'mr_uncertain', :'recon_post2');
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_event(
  (select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'mr_unres'))
  and (select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'mr_follow'))
  and (select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'mr_uncertain'))
  and (select count(*) = 0 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'recon_post2')),
  'unresolved, follow-up, uncertain-facts and reconsidered items can never be claimed for automatic publishing');
select pg_temp.check_event(
  (select count(*) = 1 from public.claim_sports_auto_publish(:'ws', :'project', :'channel', :'mr_regular')),
  'a regular eligible item can still be claimed for automatic publishing');
reset role;
select pg_temp.check_event(
  not has_function_privilege('anon', 'public.claim_sports_auto_publish(uuid,uuid,uuid,uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.claim_sports_auto_publish(uuid,uuid,uuid,uuid)', 'EXECUTE'),
  'claim_sports_auto_publish keeps its original least-privilege grants');
