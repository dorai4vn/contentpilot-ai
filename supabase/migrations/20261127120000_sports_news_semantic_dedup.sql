begin;

-- FN05: semantic event deduplication. URL and headline uniqueness stay untouched; this adds event identity
-- (participants, competition, type, date), retained evidence and structured reasons.
alter table public.sports_news_items
  add column event_key text check (event_key is null or event_key ~ '^[0-9a-f]{64}$'),
  add column cluster_key text check (cluster_key is null or cluster_key ~ '^[0-9a-f]{64}$'),
  add column event_identity jsonb check (
    event_identity is null or (jsonb_typeof(event_identity) = 'object' and length(event_identity::text) <= 4000)
  ),
  -- Why this item may only go through manual review (never the temporary auto-publish window). Null = no
  -- restriction (regular eligible item, or a row recorded before FN05).
  add column manual_review_reason text check (
    manual_review_reason is null
    or manual_review_reason in ('unresolved_identity', 'follow_up', 'reconsidered', 'uncertain_facts')
  );

create index sports_news_items_event_key on public.sports_news_items (project_id, event_key) where event_key is not null;
create index sports_news_items_cluster_key on public.sports_news_items (project_id, cluster_key) where cluster_key is not null;

create table public.sports_news_event_matches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  source_url text not null check (char_length(source_url) between 1 and 1024),
  headline_key text not null check (headline_key ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision in ('duplicate', 'follow_up')),
  event_key text not null check (event_key ~ '^[0-9a-f]{64}$'),
  matched_event_key text check (matched_event_key is null or matched_event_key ~ '^[0-9a-f]{64}$'),
  reasons jsonb not null check (jsonb_typeof(reasons) = 'array' and length(reasons::text) <= 2000),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and length(evidence::text) <= 4000),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, project_id) references public.content_projects(workspace_id, id) on delete cascade,
  unique (project_id, source_url, decision)
);
create index sports_news_event_matches_recent on public.sports_news_event_matches (project_id, created_at desc);

alter table public.sports_news_event_matches enable row level security;
revoke all on public.sports_news_event_matches from public, anon, authenticated, service_role;
grant select on public.sports_news_event_matches to authenticated;
create policy sports_event_matches_member_read on public.sports_news_event_matches for select to authenticated
using (public.is_workspace_member(workspace_id));

create function contentpilot_private.validate_sports_event(p_event jsonb)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' or length(p_event::text) > 4000
     or coalesce(p_event->>'eventKey', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_event->>'clusterKey', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_event->>'decision', '') not in ('new', 'follow_up')
     or (p_event ? 'clusterWindow' and (
           jsonb_typeof(p_event->'clusterWindow') <> 'array'
           or jsonb_array_length(p_event->'clusterWindow') not between 1 and 3
           or exists (select 1 from jsonb_array_elements(p_event->'clusterWindow') w
                      where jsonb_typeof(w) <> 'string' or (w #>> '{}') !~ '^[0-9a-f]{64}$')))
     or (p_event ? 'specific' and coalesce(p_event->>'specific', '') not in ('true', 'false'))
     or (p_event ? 'manualReviewReason' and coalesce(p_event->>'manualReviewReason', '')
         not in ('unresolved_identity', 'follow_up', 'reconsidered', 'uncertain_facts'))
     or (p_event ? 'matchedEventKey' and coalesce(p_event->>'matchedEventKey', '') !~ '^[0-9a-f]{64}$')
     or jsonb_typeof(coalesce(p_event->'reasons', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_event->'identity', '{}'::jsonb)) <> 'object' then
    raise exception 'Invalid sports news event' using errcode = '22023';
  end if;
end
$$;

-- Records a candidate that the worker skipped as a semantic duplicate, together with its evidence.
-- Idempotent per (project, source URL, decision), so retries and concurrent runs add one row.
create function public.record_sports_news_event_duplicate(
  p_workspace_id uuid, p_project_id uuid, p_source_url text, p_headline_key text, p_event jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  perform contentpilot_private.validate_sports_event(p_event);
  if not exists (
    select 1 from public.content_projects p
    where (p.workspace_id, p.id) = (p_workspace_id, p_project_id) and p.archived_at is null
  ) then
    raise exception 'Invalid sports news configuration' using errcode = '22023';
  end if;
  insert into public.sports_news_event_matches
    (workspace_id, project_id, source_url, headline_key, decision, event_key, matched_event_key, reasons, evidence)
  values (p_workspace_id, p_project_id, p_source_url, p_headline_key, 'duplicate', p_event->>'eventKey',
    p_event->>'matchedEventKey', coalesce(p_event->'reasons', '[]'::jsonb), coalesce(p_event->'evidence', '{}'::jsonb))
  on conflict (project_id, source_url, decision) do nothing;
  return found;
end
$$;

-- Whether a recorded item may block a later report of the same event. Only an item that became a real post
-- counts: low-score, failed, unselected or merely discovered items (post_id null) never block.
--   * A post that was PUBLISHED or DELIVERED always blocks, even after it is archived: content_posts.status =
--     'published', a queued/sending/succeeded publish_deliveries row, or a sending/succeeded/uncertain temporary
--     auto-publish delivery (never send the same event twice).
--   * Otherwise a post blocks only while it is not archived and not rejected (every approval request rejected);
--     an archived/rejected post that was never sent can be reconsidered, and the new post is manual-review only.
-- Mirrors blocksLaterReports() in src/lib/sports-news/event-history.ts (the auto-publish delivery table is private,
-- so only this function can see it; the database recheck is therefore the authority).
create function contentpilot_private.sports_item_blocks_event(p_workspace_id uuid, p_post_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_post_id is not null
    and exists (select 1 from public.content_posts p where p.workspace_id = p_workspace_id and p.id = p_post_id)
    and (
      exists (select 1 from public.content_posts p
              where p.workspace_id = p_workspace_id and p.id = p_post_id and p.status = 'published')
      or exists (select 1 from public.publish_deliveries d
                 where d.workspace_id = p_workspace_id and d.post_id = p_post_id
                   and d.status in ('queued', 'sending', 'succeeded'))
      or exists (select 1 from contentpilot_private.sports_auto_publish_deliveries a
                 join public.content_publish_requests r on r.id = a.request_id
                 where r.workspace_id = p_workspace_id and r.post_id = p_post_id
                   and a.state in ('sending', 'succeeded', 'uncertain'))
      or (
        exists (select 1 from public.content_posts p
                where p.workspace_id = p_workspace_id and p.id = p_post_id and p.archived_at is null)
        and not (
          exists (select 1 from public.content_publish_requests r
                  where r.workspace_id = p_workspace_id and r.post_id = p_post_id and r.status = 'rejected')
          and not exists (select 1 from public.content_publish_requests r
                          where r.workspace_id = p_workspace_id and r.post_id = p_post_id and r.status <> 'rejected')
        )
      )
    )
$$;
revoke all on function contentpilot_private.sports_item_blocks_event(uuid, uuid) from public, anon, authenticated, service_role;

-- Atomic record with event identity. The project advisory lock (same one record_sports_news takes, and
-- re-entrant inside this transaction) serializes concurrent runs, so an event is materialized once even when
-- two sources report it in parallel. The semantic recheck applies only when this call would create a post
-- (p_title not null) and the identity is specific; every other call (low score, sparse/ambiguous identity) is
-- recorded as before and never blocked nor blocking.
create function public.record_sports_news_event_assessment(
  p_workspace_id uuid, p_project_id uuid, p_source_url text, p_headline_key text,
  p_score numeric, p_title text, p_body text, p_image text, p_reason text,
  p_destinations uuid[], p_assessment jsonb, p_event jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_post uuid;
  v_key text;
  v_cluster text;
  v_window text[];
  v_specific boolean;
  v_follow boolean := false;
  v_reject text;
  v_manual text;
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  perform contentpilot_private.validate_sports_event(p_event);
  if not exists (
    select 1 from public.content_projects p
    where (p.workspace_id, p.id) = (p_workspace_id, p_project_id) and p.archived_at is null
  ) then
    raise exception 'Invalid sports news configuration' using errcode = '22023';
  end if;
  v_key := p_event->>'eventKey';
  v_cluster := p_event->>'clusterKey';
  v_specific := coalesce(p_event->>'specific', 'false') = 'true';
  -- Cluster keys for date-1/date/date+1 (the TypeScript same-subject rule accepts reports one day apart). The
  -- competition is part of every key, so two different known competitions never share a cluster.
  v_window := case when p_event ? 'clusterWindow'
    then array(select jsonb_array_elements_text(p_event->'clusterWindow')) else array[v_cluster] end;
  if not v_cluster = any(v_window) then v_window := v_window || v_cluster; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_project_id::text, 0));

  if p_title is not null and v_specific then
    -- A follow-up is honoured only if the event it extends is a real, blocking post of this project.
    v_follow := p_event->>'decision' = 'follow_up' and exists (
      select 1 from public.sports_news_items n
      where n.project_id = p_project_id and n.event_key = p_event->>'matchedEventKey' and n.event_key <> v_key
        and contentpilot_private.sports_item_blocks_event(n.workspace_id, n.post_id)
    );
    if exists (
      select 1 from public.sports_news_items n
      where n.project_id = p_project_id and n.event_key = v_key
        and contentpilot_private.sports_item_blocks_event(n.workspace_id, n.post_id)
    ) then
      v_reject := 'same_event_key';
    elsif not v_follow and exists (
      select 1 from public.sports_news_items n
      where n.project_id = p_project_id and n.cluster_key = any(v_window)
        and contentpilot_private.sports_item_blocks_event(n.workspace_id, n.post_id)
    ) then
      v_reject := 'same_event_cluster';
    end if;
  end if;
  -- Manual-review-only reasons (never auto-published): the worker's reason, else one derived here. The database
  -- re-derives them so a stale or forged payload can never open the auto-publish path.
  v_manual := nullif(p_event->>'manualReviewReason', '');
  if v_manual is null then
    if not v_specific then
      v_manual := 'unresolved_identity';
    elsif p_event->>'decision' = 'follow_up' then
      v_manual := 'follow_up';
    elsif exists (
      select 1 from public.sports_news_items n
      where n.project_id = p_project_id and n.post_id is not null
        and (n.event_key = v_key or n.cluster_key = any(v_window))
        and not contentpilot_private.sports_item_blocks_event(n.workspace_id, n.post_id)
    ) then
      v_manual := 'reconsidered';
    end if;
  end if;

  if v_reject is not null then
    insert into public.sports_news_event_matches
      (workspace_id, project_id, source_url, headline_key, decision, event_key, matched_event_key, reasons, evidence)
    values (p_workspace_id, p_project_id, p_source_url, p_headline_key, 'duplicate', v_key,
      p_event->>'matchedEventKey',
      jsonb_build_array(jsonb_build_object('code', v_reject, 'detail', 'database_recheck')),
      coalesce(p_event->'evidence', '{}'::jsonb))
    on conflict (project_id, source_url, decision) do nothing;
    return null;
  end if;

  v_post := public.record_sports_news_assessment(
    p_workspace_id, p_project_id, p_source_url, p_headline_key, p_score,
    p_title, p_body, p_image, p_reason, p_destinations, p_assessment
  );

  -- Stamp only the row inserted by this transaction (URL/headline duplicates insert nothing and old rows are
  -- never restamped). Keys are stored only for specific identities.
  update public.sports_news_items n
     set event_key = case when v_specific then v_key end,
         cluster_key = case when v_specific then v_cluster end,
         event_identity = coalesce(p_event->'identity', '{}'::jsonb),
         manual_review_reason = v_manual
   where n.project_id = p_project_id and n.source_url = p_source_url
     and n.created_at = now() and n.event_identity is null;
  if found and v_post is not null and v_specific and p_event->>'decision' = 'follow_up' then
    insert into public.sports_news_event_matches
      (workspace_id, project_id, source_url, headline_key, decision, event_key, matched_event_key, reasons, evidence)
    values (p_workspace_id, p_project_id, p_source_url, p_headline_key, 'follow_up', v_key,
      p_event->>'matchedEventKey', coalesce(p_event->'reasons', '[]'::jsonb),
      coalesce(p_event->'evidence', '{}'::jsonb) || jsonb_build_object('parentVerifiedInDatabase', v_follow))
    on conflict (project_id, source_url, decision) do nothing;
  end if;
  return v_post;
end
$$;

revoke all on function public.record_sports_news_event_duplicate(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.record_sports_news_event_assessment(
  uuid, uuid, text, text, numeric, text, text, text, text, uuid[], jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_sports_news_event_duplicate(uuid, uuid, text, text, jsonb) to authenticated;
grant execute on function public.record_sports_news_event_assessment(
  uuid, uuid, text, text, numeric, text, text, text, text, uuid[], jsonb, jsonb
) to authenticated;

-- Same body as football_automation_controls plus the FN05 manual-review-only guard (grants are preserved).
create or replace function public.claim_sports_auto_publish(p_workspace_id uuid,p_project_id uuid,p_destination_id uuid,p_post_id uuid)
returns table(id uuid, starts_at timestamptz, ends_at timestamptz, target_ref text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  w contentpilot_private.sports_auto_publish_windows;
  n public.sports_news_items;
  r public.content_publish_requests;
  p public.content_posts;
  d public.publishing_destinations;
  t timestamptz;
  published timestamptz;
  current_slot integer;
  delivery_id uuid;
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  select * into p from public.content_posts cp
    where (cp.id,cp.workspace_id,cp.project_id) = (p_post_id,p_workspace_id,p_project_id) for update;
  if not found or p.version <> 1 or p.status <> 'draft' or p.archived_at is not null then return; end if;
  select * into r from public.content_publish_requests req
    where (req.post_id,req.destination_id,req.workspace_id) = (p_post_id,p_destination_id,p_workspace_id)
      and req.status = 'pending' and req.request_source = 'agent' and req.requested_by = (select auth.uid())
      and req.post_version = 1 for update;
  if not found then return; end if;
  select * into w from contentpilot_private.sports_auto_publish_windows aw
    where (aw.workspace_id,aw.project_id,aw.destination_id) = (p_workspace_id,p_project_id,p_destination_id)
      and aw.starts_at <= clock_timestamp() and aw.ends_at > clock_timestamp()
    order by aw.starts_at desc limit 1 for update;
  if not found then return; end if;
  t := clock_timestamp();
  if t + interval '15 seconds' >= w.ends_at or p.created_at < w.starts_at or r.requested_at < w.starts_at
      or r.expires_at <= t then return; end if;
  select * into d from public.publishing_destinations dest
    where (dest.id,dest.workspace_id) = (p_destination_id,p_workspace_id) and dest.kind='telegram' and dest.status='active';
  if not found then return; end if;
  select * into n from public.sports_news_items item
    where (item.post_id,item.workspace_id,item.project_id) = (p_post_id,p_workspace_id,p_project_id);
  if not found or n.created_at < w.starts_at or n.assessment ? 'testPublishUntil'
      or n.assessment->>'rubricVersion' is distinct from 'sports-v1'
      or coalesce(n.assessment->>'decision','') not in ('threshold_met','highest_below_threshold')
      -- FN05: unresolved identities, follow-ups and reconsidered (archived/rejected) events are manual review only.
      or n.manual_review_reason is not null then return; end if;
  published := (n.assessment->>'publishedAt')::timestamptz;
  if published is null or published > t or (published at time zone 'Asia/Dubai')::date <> (t at time zone 'Asia/Dubai')::date then return; end if;
  if exists (select 1 from public.publish_deliveries x where x.post_id=p_post_id and x.destination_id=p_destination_id) then return; end if;

  if exists (select 1 from contentpilot_private.sports_auto_publish_deliveries a
    join public.content_publish_requests p_req on p_req.id=a.request_id
    where p_req.post_id=p_post_id and p_req.destination_id=p_destination_id) then return; end if;

  current_slot := floor(extract(epoch from t - w.starts_at) / 7200)::integer;
  if (select count(*) from contentpilot_private.sports_auto_publish_deliveries a where a.window_id=w.id and a.slot=current_slot) >= w.max_per_slot
      or (select count(*) from contentpilot_private.sports_auto_publish_deliveries a where a.window_id=w.id) >= w.max_per_window then return; end if;
  insert into contentpilot_private.sports_auto_publish_deliveries(window_id,request_id,slot,state)
    values(w.id,r.id,current_slot,'sending') on conflict(request_id) do nothing returning sports_auto_publish_deliveries.id into delivery_id;
  if delivery_id is not null then return query select delivery_id,w.starts_at,w.ends_at,d.target_ref,p.created_at; end if;
end
$$;

commit;
