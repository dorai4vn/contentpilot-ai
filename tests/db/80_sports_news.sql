\set ON_ERROR_STOP on

create function pg_temp.check_news(ok boolean, message text) returns void
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
\set channel '60000000-0000-4000-8000-000000000080'
\set second '60000000-0000-4000-8000-000000000081'

insert into contentpilot_private.sports_news_workers values (:'ws', :'worker');
insert into public.publishing_destinations (id, workspace_id, kind, name, target_ref)
values (:'channel', :'ws', 'telegram', 'Kênh bóng đá', '-100123456789'),
       (:'second', :'ws', 'discord', 'Kênh Discord', '123456789');

set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select public.record_sports_news(:'ws', :'project', 'https://tuoitre.vn/sports.htm', repeat('a',64),
  8, 'Bản tin', 'Tóm tắt', '/9j/example', 'RSS · 8/10', array[:'channel'::uuid, :'second'::uuid]) as post_id \gset
select pg_temp.check_news((
  select count(*) = 2 and bool_and(status = 'pending' and request_source = 'agent')
  from public.content_publish_requests where post_id = :'post_id'
), 'RSS generates one pending approval per destination');
select pg_temp.check_news(public.record_sports_news(:'ws', :'project', 'https://thanhnien.vn/sports.htm', repeat('a',64),
  9, 'Trùng tiêu đề', 'Tóm tắt', '/9j/example', 'RSS', array[:'channel'::uuid]) is null,
  'the same normalized headline does not create a second draft');
select pg_temp.check_news((select count(*) = 0 from public.claim_social_deliveries(:'ws', array[:'channel'::uuid])),
  'worker cannot send before approval');
select id as request_id from public.content_publish_requests
where post_id = :'post_id' and destination_id = :'channel' \gset

-- The bot is a Member. It cannot grant its own publishing authority.
select set_config('contentpilot.test_request', :'request_id', false);
do $$
begin
  perform public.approve_publish_request(current_setting('contentpilot.test_request')::uuid, 1);
  raise exception 'worker self-approval was permitted';
exception when insufficient_privilege then null;
end
$$;

select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_news(
  (select status = 'draft' and version = 1 from public.approve_publish_request(:'request_id', 1, :'channel')),
  'external approval leaves the internal post unchanged');

select set_config('request.jwt.claim.sub', :'worker', false);
select id as delivery_id from public.claim_social_deliveries(:'ws', array[:'channel'::uuid, :'second'::uuid])
where title = 'Bản tin' and body = 'Tóm tắt' and destination_id = :'channel' and post_version = 1 \gset
select pg_temp.check_news(
  (select count(*) = 0 from public.claim_social_deliveries(:'ws', array[:'channel'::uuid, :'second'::uuid])),
  'worker cannot claim an in-flight delivery or a different unapproved destination');
select pg_temp.check_news(public.finish_social_delivery(:'ws', :'delivery_id', '1234', null),
  'worker records platform success on the approved destination');
select pg_temp.check_news(
  (select status = 'succeeded' and external_post_id = '1234' and attempt_count = 1
   from public.publish_deliveries where id = :'delivery_id'),
  'delivery retains the provider ID and the attempt count');

select set_config('request.jwt.claim.sub', :'outsider', false);
select pg_temp.check_news((select count(*) = 0 from public.sports_news_items), 'sports media obeys workspace RLS');
select set_config('contentpilot.test_workspace', :'ws', false);
do $$
begin
  perform public.claim_social_deliveries(current_setting('contentpilot.test_workspace')::uuid, array[]::uuid[]);
  raise exception 'unregistered caller claimed deliveries';
exception when insufficient_privilege then null;
end
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select claim_id as notice_claim_id
from public.claim_sports_news_review_notices(:'ws', :'project')
where post_id = :'post_id' and score = 8 and title = 'Bản tin'
  and cardinality(request_ids) = 1 and not (:'request_id'::uuid = any(request_ids)) \gset
select pg_temp.check_news(
  (select count(*) = 0 from public.claim_sports_news_review_notices(:'ws', :'project')),
  'a claimed notice is not sent by a concurrent worker');
select pg_temp.check_news(
  public.finish_sports_news_review_notice(:'ws', :'post_id', :'notice_claim_id', false),
  'a failed notice can be retried');
select claim_id as retry_claim_id
from public.claim_sports_news_review_notices(:'ws', :'project')
where post_id = :'post_id' \gset
select pg_temp.check_news(
  not public.finish_sports_news_review_notice(:'ws', :'post_id', :'notice_claim_id', true),
  'a stale worker cannot complete a new claim');
select pg_temp.check_news(
  public.finish_sports_news_review_notice(:'ws', :'post_id', :'retry_claim_id', true),
  'a successful notice records its send time');
select pg_temp.check_news(
  (select count(*) = 0 from public.claim_sports_news_review_notices(:'ws', :'project')),
  'a successful notice is sent only once across scans');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select public.record_sports_news_assessment(:'ws', :'project', 'https://tuoitre.vn/scored.htm', repeat('b',64),
  7, null, null, null, null, array[:'channel'::uuid], '{"rubricVersion":"sports-v1","reason":"Kiểm thử"}'::jsonb);
select pg_temp.check_news(
  (select post_id is null and assessment->>'rubricVersion' = 'sports-v1' and assessment->>'reason' = 'Kiểm thử'
   from public.sports_news_items where project_id = :'project' and source_url = 'https://tuoitre.vn/scored.htm'),
  'unselected sports news retains its rubric version and assessment');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select public.record_sports_news_assessment(:'ws', :'project', 'https://tuoitre.vn/text-only.htm', repeat('c',64),
  8, 'Tin không có ảnh', 'Caption thể thao', null, 'Kiểm thử', array[:'channel'::uuid], '{"photo":null}'::jsonb) as text_only_post \gset
select pg_temp.check_news(
  (select not has_image and image_base64 is null from public.sports_news_items where post_id = :'text_only_post'),
  'a sports draft can be recorded with no licensed photo');
reset role;

insert into contentpilot_private.sports_auto_publish_windows(workspace_id,project_id,destination_id,starts_at,ends_at)
values(:'ws',:'project',:'channel',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '7 hours');

set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_news((select count(*)=1 from public.get_sports_auto_publish_window(:'ws',:'project',:'channel')),
  'the registered Member sees the active temporary Telegram window');
select pg_temp.check_news((select count(*)=0 from public.get_sports_auto_publish_window(:'ws',:'project',:'second')),
  'the temporary window cannot apply to Discord');

select public.record_sports_news_assessment(:'ws',:'project','https://tuoitre.vn/auto1.htm',repeat('d',64),9,
  'Auto 1','Caption',null,'Test',array[:'channel'::uuid],
  jsonb_build_object('publishedAt',clock_timestamp(),'rubricVersion','sports-v1','decision','threshold_met')) as auto_one \gset
select public.record_sports_news_assessment(:'ws',:'project','https://tuoitre.vn/auto2.htm',repeat('e',64),8,
  'Auto 2','Caption',null,'Test',array[:'channel'::uuid],
  jsonb_build_object('publishedAt',clock_timestamp(),'rubricVersion','sports-v1','decision','threshold_met')) as auto_two \gset
select public.record_sports_news_assessment(:'ws',:'project','https://tuoitre.vn/auto3.htm',repeat('f',64),8,
  'Auto 3','Caption',null,'Test',array[:'channel'::uuid],
  jsonb_build_object('publishedAt',clock_timestamp(),'rubricVersion','sports-v1','decision','threshold_met')) as auto_three \gset
select id as first_auto from public.claim_sports_auto_publish(:'ws',:'project',:'channel',:'auto_one') \gset
select id as second_auto from public.claim_sports_auto_publish(:'ws',:'project',:'channel',:'auto_two') \gset
do $$
declare i integer; post_id uuid;
begin
  for i in 4..11 loop
    post_id := public.record_sports_news_assessment(
      '6c000000-0000-0000-0000-000000000001'::uuid,
      '6c100000-0000-0000-0000-000000000001'::uuid,
      'https://tuoitre.vn/auto' || i || '.htm',
      repeat(i::text,64), 8, 'Auto ' || i, 'Caption', null, 'Test',
      array['60000000-0000-4000-8000-000000000080'::uuid],
      jsonb_build_object('publishedAt',clock_timestamp(),'rubricVersion','sports-v1','decision','threshold_met'));
    perform public.claim_sports_auto_publish(
      '6c000000-0000-0000-0000-000000000001'::uuid,
      '6c100000-0000-0000-0000-000000000001'::uuid,
      '60000000-0000-4000-8000-000000000080'::uuid, post_id);
  end loop;
end $$;
select pg_temp.check_news(
  (select count(*)=10 from contentpilot_private.sports_auto_publish_deliveries),
  'ten reservations fit this two-hour slot');
select pg_temp.check_news((select count(*)=0 from public.claim_sports_auto_publish(:'ws',:'project',:'channel',:'auto_three')),
  'ten reservations exhaust this two-hour slot even across worker retries');
select pg_temp.check_news(public.finish_sports_auto_publish(:'ws',:'first_auto','639',null),
  'automatic success records the Telegram message ID');
select pg_temp.check_news(public.finish_sports_auto_publish(:'ws',:'second_auto',null,'content_rejected'),
  'definite automatic failure leaves the draft available for human approval');
select pg_temp.check_news((select status='cancelled' from public.content_publish_requests where post_id=:'auto_one'),
  'a delivered automatic post is removed from the pending queue without a fake approval');
select pg_temp.check_news((select status='pending' from public.content_publish_requests where post_id=:'auto_two'),
  'a definite failure leaves the human approval pending');

reset role;
update contentpilot_private.sports_auto_publish_windows
set starts_at=clock_timestamp()-interval '8 hours', ends_at=clock_timestamp()-interval '1 minute'
where workspace_id=:'ws';
set role authenticated;
select set_config('request.jwt.claim.sub', :'worker', false);
select pg_temp.check_news((select count(*)=0 from public.get_sports_auto_publish_window(:'ws',:'project',:'channel')),
  'the temporary window closes at its database deadline');
select pg_temp.check_news((select count(*)=0 from public.claim_sports_auto_publish(:'ws',:'project',:'channel',:'auto_three')),
  'no automatic send is reserved after expiry');
select id as human_request from public.content_publish_requests where post_id=:'auto_three' \gset
select set_config('request.jwt.claim.sub', :'owner', false);
select pg_temp.check_news(
  (select status='draft' from public.approve_publish_request(:'human_request',1,:'channel')),
  'human approval still creates a normal publication after expiry');
reset role;
