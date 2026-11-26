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
