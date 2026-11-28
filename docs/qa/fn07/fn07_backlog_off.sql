\set ON_ERROR_STOP on
-- FN07 evidence: approved backlog + Off behaviour. Runs on the DISPOSABLE PG17 left behind by `npm run test:db`.
\set ws '6c000000-0000-0000-0000-000000000001'
\set project '6c100000-0000-0000-0000-000000000001'
\set worker '00000000-0000-0000-0000-0000000006c3'
\set owner '00000000-0000-0000-0000-0000000006c1'
\set channel '60000000-0000-4000-8000-000000000080'
\set second '60000000-0000-4000-8000-000000000081'
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select public.record_sports_news(:'ws', :'project', 'https://tuoitre.vn/fn07-backlog-' || md5(random()::text) || '.htm', md5(random()::text) || md5(random()::text),
  8, 'FN07 backlog probe headline', 'Tom tat', '/9j/example', 'RSS', array[:'channel'::uuid, :'second'::uuid]) as post_id \gset
select set_config('request.jwt.claim.sub', :'owner', false);
select id as r1 from public.content_publish_requests where post_id=:'post_id' and destination_id=:'channel' \gset
select id as r2 from public.content_publish_requests where post_id=:'post_id' and destination_id=:'second' \gset
select status from public.approve_publish_request(:'r1',1,:'channel') \gset
select status from public.approve_publish_request(:'r2',1,:'second') \gset
\echo '--- mode now:'
select mode, version from public.get_sports_automation_mode(:'ws',:'project');
select public.set_sports_automation_mode(:'ws',:'project',:'channel','off',40) as v \gset
\echo '--- OFF: claim for telegram(channel)+discord(second) destinations'
select set_config('request.jwt.claim.sub', :'worker', false);
select d.kind, c.post_version from public.claim_social_deliveries(:'ws', array[:'channel'::uuid,:'second'::uuid]) c join public.publishing_destinations d on d.id=c.destination_id;
select 'queued deliveries still waiting' as note, count(*) from public.publish_deliveries where post_id=:'post_id' and status='queued';
select set_config('request.jwt.claim.sub', :'owner', false);
select public.set_sports_automation_mode(:'ws',:'project',:'channel','semi',40) as v \gset
\echo '--- SEMI after OFF: claim again'
select set_config('request.jwt.claim.sub', :'worker', false);
select d.kind, c.post_version from public.claim_social_deliveries(:'ws', array[:'channel'::uuid,:'second'::uuid]) c join public.publishing_destinations d on d.id=c.destination_id;
