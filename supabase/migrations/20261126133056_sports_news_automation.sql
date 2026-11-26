begin;

alter table public.publishing_destinations
  drop constraint publishing_destinations_kind_check,
  add constraint publishing_destinations_kind_check check (
    kind in ('internal', 'telegram', 'discord', 'facebook')
  ),
  add constraint publishing_destinations_external_target check (
    kind = 'internal' or (target_ref is not null and case kind
      when 'telegram' then target_ref ~ '^-100[0-9]{5,18}$'
      else target_ref ~ '^[0-9]{5,25}$'
    end)
  );

-- An approval names a destination ID. Retargeting that ID would silently change
-- who receives earlier approvals, so a different account requires a new row.
revoke update (target_ref) on public.publishing_destinations from authenticated;

create schema if not exists contentpilot_private;
revoke all on schema contentpilot_private from public, anon, authenticated;

create table contentpilot_private.sports_news_workers (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade
);

create function contentpilot_private.can_run_news(p_workspace_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from contentpilot_private.sports_news_workers w
    where w.workspace_id = p_workspace_id and w.user_id = (select auth.uid())
      and public.has_workspace_role(w.workspace_id, array['member']::public.workspace_role[])
  )
$$;

create table public.sports_news_items (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  source_url text not null check (char_length(source_url) between 1 and 1024),
  headline_key text not null check (headline_key ~ '^[0-9a-f]{64}$'),
  score numeric(3,1) not null check (score between 0 and 10),
  post_id uuid,
  image_base64 text check (length(image_base64) between 1 and 2000000),
  created_at timestamptz not null default now(),
  primary key (project_id, source_url),
  unique (project_id, headline_key),
  unique (post_id),
  foreign key (workspace_id, project_id) references public.content_projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, post_id) references public.content_posts(workspace_id, id) on delete restrict,
  check ((post_id is null) = (image_base64 is null))
);

create index sports_news_items_project_recent
  on public.sports_news_items (project_id, created_at desc);

alter table public.sports_news_items enable row level security;
revoke all on public.sports_news_items from public, anon, authenticated, service_role;
grant select on public.sports_news_items to authenticated;
create policy sports_news_member_read on public.sports_news_items for select to authenticated
using (public.is_workspace_member(workspace_id));

-- Atomic decision/draft/snapshot/approval requests. Concurrent runs can assess
-- the same item, but only one can insert a post or request for that item.
create function public.record_sports_news(
  p_workspace_id uuid, p_project_id uuid, p_source_url text, p_headline_key text,
  p_score numeric, p_title text, p_body text, p_image text, p_reason text, p_destinations uuid[]
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_post uuid;
  v_channel uuid;
  v_turn uuid := gen_random_uuid();
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  if cardinality(p_destinations) > 12 or not exists (
    select 1 from public.content_projects p
    where (p.workspace_id, p.id) = (p_workspace_id, p_project_id) and p.archived_at is null
  ) then
    raise exception 'Invalid sports news configuration' using errcode = '22023';
  end if;

  -- A project-scoped advisory lock covers URL AND normalized headline races.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_project_id::text, 0));
  if exists (
    select 1 from public.sports_news_items n where n.project_id = p_project_id
      and (n.source_url = p_source_url or n.headline_key = p_headline_key)
  ) then return null; end if;

  if p_title is not null then
    insert into public.content_posts (workspace_id, project_id, title, body, last_change_source)
      values (p_workspace_id, p_project_id, p_title, p_body, 'agent') returning id into v_post;
    for v_channel in
      select d.id from public.publishing_destinations d
      where d.workspace_id = p_workspace_id and d.id = any(p_destinations)
        and d.kind <> 'internal' and d.status = 'active'
    loop
      perform public.request_post_publish(v_post, 1, 'agent', v_turn, p_reason, v_channel);
    end loop;
  end if;

  insert into public.sports_news_items
    (workspace_id, project_id, source_url, headline_key, score, post_id, image_base64)
    values (p_workspace_id, p_project_id, p_source_url, p_headline_key, p_score, v_post, p_image);
  return v_post;
end
$$;

-- Claim only previously approved deliveries. Timeouts and crashes are
-- ambiguous at most providers, so expired claims are never replayed.
create function public.claim_social_deliveries(p_workspace_id uuid, p_destinations uuid[])
returns table (
  id uuid, destination_id uuid, kind text, target_ref text,
  idempotency_key text, post_id uuid, post_version integer, title text, body text
) language plpgsql security definer set search_path = '' as $$
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;

  update public.publish_deliveries q
     set status = 'failed', completed_at = now(), next_attempt_at = null,
         last_error_code = 'delivery_unconfirmed'
   where q.workspace_id = p_workspace_id and q.destination_id = any(p_destinations)
     and q.status = 'sending' and q.updated_at < now() - interval '5 minutes';

  return query
  with candidates as (
    select q.id
    from public.publish_deliveries q
    join public.publishing_destinations d on d.id = q.destination_id
    where q.workspace_id = p_workspace_id and q.destination_id = any(p_destinations)
      and q.status in ('queued', 'failed') and q.next_attempt_at <= now()
      and d.status = 'active' and d.kind <> 'internal' and q.attempt_count < 4
    order by q.next_attempt_at, q.id
    limit 6 for update of q skip locked
  ), claimed as (
    update public.publish_deliveries q
       set status = 'sending', attempt_count = q.attempt_count + 1, completed_at = null,
           next_attempt_at = null, last_error_code = null
    from candidates c where q.id = c.id
    returning q.*
  )
  select q.id, d.id, d.kind, d.target_ref, q.idempotency_key, q.post_id, q.post_version, v.title, v.body
  from claimed q
  join public.publishing_destinations d on d.id = q.destination_id
  join public.content_post_versions v on (v.post_id, v.version) = (q.post_id, q.post_version);
end
$$;

create function public.finish_social_delivery(
  p_workspace_id uuid, p_id uuid, p_external_id text, p_error_code text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  if (p_external_id is null) = (p_error_code is null) then
    raise exception 'Expected exactly one delivery outcome' using errcode = '22023';
  end if;
  update public.publish_deliveries q
     set status = case when p_external_id is null then 'failed' else 'succeeded' end,
         external_post_id = p_external_id, last_error_code = p_error_code, completed_at = now(),
         next_attempt_at = case when p_error_code = 'rate_limited' and q.attempt_count < 4
           then now() + interval '5 minutes' * power(2, q.attempt_count - 1) end
   where q.id = p_id and q.workspace_id = p_workspace_id and q.status = 'sending'
     and exists (select 1 from public.publishing_destinations d
       where d.id = q.destination_id and d.kind <> 'internal');
  return found;
end
$$;

revoke all on function public.record_sports_news(uuid, uuid, text, text, numeric, text, text, text, text, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.claim_social_deliveries(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.finish_social_delivery(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.record_sports_news(uuid, uuid, text, text, numeric, text, text, text, text, uuid[])
  to authenticated;
grant execute on function public.claim_social_deliveries(uuid, uuid[]) to authenticated;
grant execute on function public.finish_social_delivery(uuid, uuid, text, text) to authenticated;

commit;
