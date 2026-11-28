-- FN08 addenda (owner-approved 2026-11-28):
--  * missing mode configuration fails safe to OFF (never silently starts RSS/AI/delivery); Emergency Stop => Off.
--  * 3 distinct news posts per scan / 2h delivery slot (persistent Auto windows), quota unchanged.
--  * scoring V2 (sports-v2): Popularity 30 / Importance 25 / Recency 25 / Engagement 20; explicit custom
--    configurations and historical scores are preserved (legacy rows keep their weights with engagement 0).
--  * Existing approved deliveries keep resuming on Semi/Auto; they wait on Off or when nothing is configured.
begin;

create or replace function contentpilot_private.automation_mode(p_workspace_id uuid, p_project_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select m.mode from contentpilot_private.sports_automation_modes m
    where (m.workspace_id, m.project_id) = (p_workspace_id, p_project_id)), 'off')
$$;

create or replace function public.get_sports_automation_mode(p_workspace_id uuid, p_project_id uuid)
returns table(mode text, daily_quota integer, version integer, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  return query select m.mode, m.daily_quota, m.version, m.updated_at
    from contentpilot_private.sports_automation_modes m
    where (m.workspace_id, m.project_id) = (p_workspace_id, p_project_id);
  if not found then return query select 'off'::text, 40, 0, null::timestamptz; end if;
end
$$;

-- Persistent Auto windows output at most 3 posts per 2h slot; open windows are tightened without touching history.
update contentpilot_private.sports_auto_publish_windows set max_per_slot = 3 where persistent and max_per_slot > 3;
create or replace function public.set_sports_automation_mode(
  p_workspace_id uuid, p_project_id uuid, p_destination_id uuid, p_mode text, p_daily_quota integer
) returns integer language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz; v_old text; v_version integer;
begin
  if not public.has_workspace_role(p_workspace_id, array['owner','admin']::public.workspace_role[]) then
    raise exception 'Only Owner/Admin can change automation' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('off','semi','auto') or p_daily_quota is null or p_daily_quota not between 1 and 120 then
    raise exception 'Invalid automation mode' using errcode = '22023';
  end if;
  perform 1 from public.content_projects p where (p.id,p.workspace_id)=(p_project_id,p_workspace_id) and p.archived_at is null;
  if not found then raise exception 'Project unavailable' using errcode = '22023'; end if;
  perform 1 from public.publishing_destinations d
    where (d.id,d.workspace_id)=(p_destination_id,p_workspace_id) and d.kind='telegram' and d.status='active' for update;
  if not found then raise exception 'Active Telegram destination required' using errcode = '22023'; end if;
  v_now := clock_timestamp();
  perform pg_advisory_xact_lock(hashtextextended('automation:' || p_workspace_id || p_project_id, 0));
  v_old := contentpilot_private.automation_mode(p_workspace_id, p_project_id);
  update contentpilot_private.sports_auto_publish_windows w
     set ends_at = v_now, stopped_by = (select auth.uid())
   where (w.workspace_id,w.project_id,w.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
     and w.starts_at < v_now and w.ends_at > v_now;
  if p_mode = 'auto' then
    insert into contentpilot_private.sports_auto_publish_windows
      (workspace_id,project_id,destination_id,starts_at,ends_at,persistent,max_per_slot,max_per_window,max_per_day)
    values (p_workspace_id,p_project_id,p_destination_id,v_now,'infinity',true,3,40,p_daily_quota);
  end if;
  insert into contentpilot_private.sports_automation_modes as m
    (workspace_id,project_id,destination_id,mode,daily_quota,updated_by,updated_at)
  values (p_workspace_id,p_project_id,p_destination_id,p_mode,p_daily_quota,(select auth.uid()),v_now)
  on conflict (workspace_id,project_id) do update
    set destination_id=excluded.destination_id, mode=excluded.mode, daily_quota=excluded.daily_quota,
        version=m.version+1, updated_by=excluded.updated_by, updated_at=excluded.updated_at
  returning m.version into v_version;
  insert into contentpilot_private.sports_automation_events(workspace_id,project_id,from_mode,to_mode,daily_quota,actor,created_at)
  values (p_workspace_id,p_project_id,v_old,p_mode,p_daily_quota,(select auth.uid()),v_now);
  return v_version;
end
$$;

-- Scoring V2: four weights. Existing rows keep their explicit weights (engagement 0); rows still on the old
-- shipped defaults (45/40/15) move to the new defaults. New rows default to 30/25/25/20.
alter table public.sports_news_scoring_configs
  add column engagement_weight integer not null default 0 check (engagement_weight between 0 and 100);
alter table public.sports_news_scoring_configs drop constraint sports_news_scoring_configs_check;
alter table public.sports_news_scoring_configs
  add constraint sports_news_scoring_weights_sum check (reach_weight + importance_weight + freshness_weight + engagement_weight = 100);
update public.sports_news_scoring_configs
   set reach_weight = 30, importance_weight = 25, freshness_weight = 25, engagement_weight = 20, version = version + 1
 where (reach_weight, importance_weight, freshness_weight, engagement_weight) = (45, 40, 15, 0);
alter table public.sports_news_scoring_configs
  alter column reach_weight set default 30, alter column importance_weight set default 25,
  alter column freshness_weight set default 25, alter column engagement_weight set default 20;

drop function public.set_sports_news_scoring_config(uuid,uuid,numeric,integer,integer,integer,text);
create function public.set_sports_news_scoring_config(
  p_workspace_id uuid,p_project_id uuid,p_threshold numeric,p_reach_weight integer,
  p_importance_weight integer,p_freshness_weight integer,p_engagement_weight integer,p_fallback_mode text
) returns integer language plpgsql security definer set search_path = '' as $$
declare new_version integer;
begin
  if not public.has_workspace_role(p_workspace_id,array['owner','admin']::public.workspace_role[]) then
    raise exception 'Only Owner/Admin can change scoring' using errcode = '42501';
  end if;
  if p_threshold is null or p_threshold < 0 or p_threshold > 10 or p_threshold * 10 <> trunc(p_threshold * 10)
    or p_reach_weight is null or p_importance_weight is null or p_freshness_weight is null or p_engagement_weight is null
    or p_reach_weight < 0 or p_importance_weight < 0 or p_freshness_weight < 0 or p_engagement_weight < 0
    or p_reach_weight + p_importance_weight + p_freshness_weight + p_engagement_weight <> 100
    or p_fallback_mode is null or p_fallback_mode not in ('highest','strict') then
    raise exception 'Invalid scoring configuration' using errcode = '22023';
  end if;
  perform 1 from public.content_projects p where (p.workspace_id,p.id)=(p_workspace_id,p_project_id)
    and p.archived_at is null;
  if not found then raise exception 'Project unavailable' using errcode = '22023'; end if;
  insert into public.sports_news_scoring_configs
    (workspace_id,project_id,threshold,reach_weight,importance_weight,freshness_weight,engagement_weight,fallback_mode,updated_by)
  values(p_workspace_id,p_project_id,p_threshold,p_reach_weight,p_importance_weight,p_freshness_weight,p_engagement_weight,p_fallback_mode,(select auth.uid()))
  on conflict(project_id) do update set
    version=public.sports_news_scoring_configs.version+1,
    threshold=excluded.threshold,
    reach_weight=excluded.reach_weight,
    importance_weight=excluded.importance_weight,
    freshness_weight=excluded.freshness_weight,
    engagement_weight=excluded.engagement_weight,
    fallback_mode=excluded.fallback_mode,
    updated_by=excluded.updated_by,
    updated_at=clock_timestamp()
  where public.sports_news_scoring_configs.workspace_id=p_workspace_id
  returning version into new_version;
  if new_version is null then raise exception 'Workspace mismatch' using errcode = '42501'; end if;
  return new_version;
end
$$;
revoke all on function public.set_sports_news_scoring_config(uuid,uuid,numeric,integer,integer,integer,integer,text)
  from public,anon,authenticated,service_role;
grant execute on function public.set_sports_news_scoring_config(uuid,uuid,numeric,integer,integer,integer,integer,text)
  to authenticated;

-- Windows accept both rubric versions (history stays eligible); delivery claims fail safe when unconfigured.
create or replace function public.claim_sports_auto_publish(p_workspace_id uuid,p_project_id uuid,p_destination_id uuid,p_post_id uuid)
returns table(id uuid, starts_at timestamptz, ends_at timestamptz, target_ref text, created_at timestamptz, persistent boolean)
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
  v_mode text;
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
  -- Mode is read after the window lock: a concurrent switch either committed first (no window) or waits for us.
  v_mode := contentpilot_private.automation_mode(p_workspace_id,p_project_id);
  if v_mode = 'off' or (w.persistent and v_mode <> 'auto') then return; end if;
  t := clock_timestamp();
  if t + interval '15 seconds' >= w.ends_at or p.created_at < w.starts_at or r.requested_at < w.starts_at
      or r.expires_at <= t then return; end if;
  select * into d from public.publishing_destinations dest
    where (dest.id,dest.workspace_id) = (p_destination_id,p_workspace_id) and dest.kind='telegram' and dest.status='active';
  if not found then return; end if;
  select * into n from public.sports_news_items item
    where (item.post_id,item.workspace_id,item.project_id) = (p_post_id,p_workspace_id,p_project_id);
  if not found or n.created_at < w.starts_at or n.assessment ? 'testPublishUntil'
      or n.assessment->>'rubricVersion' not in ('sports-v1','sports-v2')
      or coalesce(n.assessment->>'decision','') not in ('threshold_met','highest_below_threshold')
      -- Temporary windows keep FN05 manual review; persistent Auto (owner-approved FN08) permits
      -- unresolved_identity / uncertain_facts / follow_up / reconsidered. Confirmed duplicates never become posts.
      or (n.manual_review_reason is not null and not w.persistent) then return; end if;
  published := (n.assessment->>'publishedAt')::timestamptz;
  if published is null or published > t or (published at time zone 'Asia/Dubai')::date <> (t at time zone 'Asia/Dubai')::date then return; end if;
  if exists (select 1 from public.publish_deliveries x where x.post_id=p_post_id and x.destination_id=p_destination_id) then return; end if;

  if exists (select 1 from contentpilot_private.sports_auto_publish_deliveries a
    join public.content_publish_requests p_req on p_req.id=a.request_id
    where p_req.post_id=p_post_id and p_req.destination_id=p_destination_id) then return; end if;

  if w.persistent then
    -- 2h cadence slots are global; the quota is per Dubai day across every persistent window of the destination.
    current_slot := floor(extract(epoch from t) / 7200)::integer;
    if (select count(*) from contentpilot_private.sports_auto_publish_deliveries a
          join contentpilot_private.sports_auto_publish_windows aw on aw.id=a.window_id
         where (aw.workspace_id,aw.project_id,aw.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
           and a.slot=current_slot) >= w.max_per_slot
       or (select count(*) from contentpilot_private.sports_auto_publish_deliveries a
          join contentpilot_private.sports_auto_publish_windows aw on aw.id=a.window_id
         where (aw.workspace_id,aw.project_id,aw.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
           and (a.started_at at time zone 'Asia/Dubai')::date=(t at time zone 'Asia/Dubai')::date) >= w.max_per_day then return; end if;
  else
    current_slot := floor(extract(epoch from t - w.starts_at) / 7200)::integer;
    if (select count(*) from contentpilot_private.sports_auto_publish_deliveries a where a.window_id=w.id and a.slot=current_slot) >= w.max_per_slot
       or (select count(*) from contentpilot_private.sports_auto_publish_deliveries a where a.window_id=w.id) >= w.max_per_window then return; end if;
  end if;
  insert into contentpilot_private.sports_auto_publish_deliveries(window_id,request_id,slot,state)
    values(w.id,r.id,current_slot,'sending') on conflict(request_id) do nothing returning sports_auto_publish_deliveries.id into delivery_id;
  if delivery_id is not null then
    return query select delivery_id,w.starts_at,nullif(w.ends_at,'infinity'::timestamptz),d.target_ref,p.created_at,w.persistent;
  end if;
end
$$;

create or replace function public.claim_social_deliveries(p_workspace_id uuid, p_destinations uuid[])
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
      -- Fail safe: a destination without an explicit Semi/Auto configuration never delivers (missing = Off).
      and exists (select 1 from contentpilot_private.sports_automation_modes m
        where m.workspace_id = p_workspace_id and m.destination_id = q.destination_id and m.mode in ('semi','auto'))
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

revoke all on function public.claim_sports_auto_publish(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_sports_auto_publish(uuid,uuid,uuid,uuid) to authenticated;

commit;
