begin;

-- FN05: semantic event deduplication. URL and headline uniqueness stay untouched; this adds event identity
-- (participants, competition, type, date), retained evidence and structured reasons.
alter table public.sports_news_items
  add column event_key text check (event_key is null or event_key ~ '^[0-9a-f]{64}$'),
  add column cluster_key text check (cluster_key is null or cluster_key ~ '^[0-9a-f]{64}$'),
  add column event_identity jsonb check (
    event_identity is null or (jsonb_typeof(event_identity) = 'object' and length(event_identity::text) <= 4000)
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
     or (p_event ? 'specific' and coalesce(p_event->>'specific', '') not in ('true', 'false'))
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
-- counts: low-score, failed, unselected or merely discovered items (post_id null) never block. A post that is
-- archived, or whose approval requests were all rejected, no longer blocks either, so a later and stronger report
-- goes through the normal review path. Delivered/pending/approved/cancelled posts keep blocking (no duplicate
-- delivery). Mirrors blocksLaterReports() in src/lib/sports-news/event-history.ts.
create function contentpilot_private.sports_item_blocks_event(p_workspace_id uuid, p_post_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_post_id is not null
    and exists (select 1 from public.content_posts p
                where p.workspace_id = p_workspace_id and p.id = p_post_id and p.archived_at is null)
    and not (
      exists (select 1 from public.content_publish_requests r
              where r.workspace_id = p_workspace_id and r.post_id = p_post_id and r.status = 'rejected')
      and not exists (select 1 from public.content_publish_requests r
                      where r.workspace_id = p_workspace_id and r.post_id = p_post_id and r.status <> 'rejected')
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
  v_specific boolean;
  v_follow boolean := false;
  v_reject text;
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
      where n.project_id = p_project_id and n.cluster_key = v_cluster
        and contentpilot_private.sports_item_blocks_event(n.workspace_id, n.post_id)
    ) then
      v_reject := 'same_event_cluster';
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
         event_identity = coalesce(p_event->'identity', '{}'::jsonb)
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

commit;
