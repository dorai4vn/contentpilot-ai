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

\set event_a '{"decision":"new","eventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","identity":{"version":"event-v1","type":"match_result"},"reasons":[{"code":"no_matching_event"}]}'
\set event_dup_cluster '{"decision":"new","eventKey":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","identity":{"version":"event-v1"},"reasons":[]}'
\set event_follow '{"decision":"follow_up","matchedEventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","eventKey":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","identity":{"version":"event-v1","status":"official"},"reasons":[{"code":"status_upgraded","detail":"rumor->official"}],"evidence":{"matchedTitle":"Tin đồn"}}'
\set event_orphan '{"decision":"follow_up","matchedEventKey":"9999999999999999999999999999999999999999999999999999999999999999","eventKey":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","identity":{"version":"event-v1"},"reasons":[]}'

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
  '{"decision":"new","eventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","matchedEventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reasons":[{"code":"participants_overlap"}],"evidence":{"matchedUrl":"https://tuoitre.vn/event-a.htm"}}'::jsonb),
  'a pre-filtered duplicate is recorded with its evidence');
select pg_temp.check_event(not public.record_sports_news_event_duplicate(:'ws', :'project', 'https://skip.vn/a.htm', repeat('9',64),
  '{"decision":"new","eventKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clusterKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","reasons":[]}'::jsonb),
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
