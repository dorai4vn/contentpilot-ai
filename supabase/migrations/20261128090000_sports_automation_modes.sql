-- FN08: three-mode automation control (Off / Semi / Auto), enforced in the database.
--  * absent row = 'semi' (today's behaviour: RSS + drafts + human approval). Nothing is silently switched to auto.
--  * 'auto' is persistent (no expiry) until the mode changes; it is backed by a persistent window row so the
--    existing claim/idempotency/lease machinery is reused. Legacy temporary windows keep working unchanged.
--  * 'off' closes every window, blocks new drafts (trigger) and blocks delivery claims.
begin;

-- Persistent windows: no 8 hour cap, global 2h slots, daily quota.
alter table contentpilot_private.sports_auto_publish_windows
  add column persistent boolean not null default false,
  add column max_per_day integer not null default 40 check (max_per_day between 1 and 120);
do $$
declare c text;
begin
  for c in select conname from pg_constraint
    where conrelid = 'contentpilot_private.sports_auto_publish_windows'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%interval%' loop
    execute format('alter table contentpilot_private.sports_auto_publish_windows drop constraint %I', c);
  end loop;
  for c in select conname from pg_constraint
    where conrelid = 'contentpilot_private.sports_auto_publish_deliveries'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%slot%' loop
    execute format('alter table contentpilot_private.sports_auto_publish_deliveries drop constraint %I', c);
  end loop;
end $$;
alter table contentpilot_private.sports_auto_publish_windows
  add constraint sports_auto_window_bounds check (
    ends_at > starts_at and (persistent or ends_at <= starts_at + interval '8 hours'));
alter table contentpilot_private.sports_auto_publish_deliveries
  add constraint sports_auto_delivery_slot check (slot >= 0);
create unique index sports_auto_one_open_persistent
  on contentpilot_private.sports_auto_publish_windows(workspace_id, project_id, destination_id)
  where persistent and ends_at = 'infinity';

create table contentpilot_private.sports_automation_modes (
  workspace_id uuid not null,
  project_id uuid not null,
  destination_id uuid not null,
  mode text not null check (mode in ('off','semi','auto')),
  daily_quota integer not null default 40 check (daily_quota between 1 and 120),
  version integer not null default 1,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, project_id),
  foreign key (workspace_id, project_id) references public.content_projects(workspace_id, id),
  foreign key (workspace_id, destination_id) references public.publishing_destinations(workspace_id, id)
);
create table contentpilot_private.sports_automation_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  from_mode text not null,
  to_mode text not null,
  daily_quota integer not null,
  actor uuid references auth.users(id),
  created_at timestamptz not null default clock_timestamp()
);
create index sports_automation_events_ws on contentpilot_private.sports_automation_events(workspace_id, project_id, created_at desc);

create function contentpilot_private.automation_mode(p_workspace_id uuid, p_project_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select m.mode from contentpilot_private.sports_automation_modes m
    where (m.workspace_id, m.project_id) = (p_workspace_id, p_project_id)), 'semi')
$$;
revoke all on function contentpilot_private.automation_mode(uuid,uuid) from public, anon, authenticated, service_role;

create function public.get_sports_automation_mode(p_workspace_id uuid, p_project_id uuid)
returns table(mode text, daily_quota integer, version integer, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  return query select m.mode, m.daily_quota, m.version, m.updated_at
    from contentpilot_private.sports_automation_modes m
    where (m.workspace_id, m.project_id) = (p_workspace_id, p_project_id);
  if not found then return query select 'semi'::text, 40, 0, null::timestamptz; end if;
end
$$;

create function public.list_sports_automation_events(p_workspace_id uuid, p_project_id uuid)
returns table(from_mode text, to_mode text, daily_quota integer, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  return query select e.from_mode, e.to_mode, e.daily_quota, e.created_at
    from contentpilot_private.sports_automation_events e
    where (e.workspace_id, e.project_id) = (p_workspace_id, p_project_id)
    order by e.created_at desc limit 20;
end
$$;

create function public.set_sports_automation_mode(
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
  -- Serialise transitions per project, then close every open window (legacy or persistent).
  perform pg_advisory_xact_lock(hashtextextended('automation:' || p_workspace_id || p_project_id, 0));
  v_old := contentpilot_private.automation_mode(p_workspace_id, p_project_id);
  update contentpilot_private.sports_auto_publish_windows w
     set ends_at = v_now, stopped_by = (select auth.uid())
   where (w.workspace_id,w.project_id,w.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
     and w.starts_at < v_now and w.ends_at > v_now;
  if p_mode = 'auto' then
    -- A fresh window: only drafts created from now on are eligible, so there is no backlog replay.
    insert into contentpilot_private.sports_auto_publish_windows
      (workspace_id,project_id,destination_id,starts_at,ends_at,persistent,max_per_slot,max_per_window,max_per_day)
    values (p_workspace_id,p_project_id,p_destination_id,v_now,'infinity',true,10,40,p_daily_quota);
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

-- The legacy temporary-window control must not fight the new modes.
create or replace function public.set_sports_auto_publish_control(
  p_workspace_id uuid,p_project_id uuid,p_destination_id uuid,p_enabled boolean,
  p_hours integer,p_slot_limit integer,p_window_limit integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz;
begin
  if not public.has_workspace_role(p_workspace_id,array['owner','admin']::public.workspace_role[]) then
    raise exception 'Only Owner/Admin can change automation' using errcode = '42501';
  end if;
  if contentpilot_private.automation_mode(p_workspace_id,p_project_id) <> 'semi' then
    raise exception 'Use the automation mode control' using errcode = '22023';
  end if;
  if p_enabled is null or p_hours not between 1 and 8 or p_slot_limit not between 1 and 10
      or p_window_limit not between p_slot_limit and 40 then
    raise exception 'Invalid automation limits' using errcode = '22023';
  end if;
  perform 1 from public.content_projects p where (p.id,p.workspace_id)=(p_project_id,p_workspace_id)
    and p.archived_at is null;
  if not found then raise exception 'Project unavailable' using errcode = '22023'; end if;
  perform 1 from public.publishing_destinations d
    where (d.id,d.workspace_id)=(p_destination_id,p_workspace_id)
      and d.kind='telegram' and d.status='active' for update;
  if not found then raise exception 'Active Telegram destination required' using errcode = '22023'; end if;
  v_now := clock_timestamp();
  update contentpilot_private.sports_auto_publish_windows w
    set ends_at=v_now, stopped_by=(select auth.uid())
    where (w.workspace_id,w.project_id,w.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
      and w.starts_at < v_now and w.ends_at > v_now;
  if p_enabled then
    insert into contentpilot_private.sports_auto_publish_windows
      (workspace_id,project_id,destination_id,starts_at,ends_at,max_per_slot,max_per_window)
    values(p_workspace_id,p_project_id,p_destination_id,v_now, v_now + make_interval(hours => p_hours),p_slot_limit,p_window_limit);
  end if;
  return true;
end
$$;

-- Off: no new drafts or skip evidence may be stored (the worker also stops earlier, before any external call).
create function contentpilot_private.guard_automation_off()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if contentpilot_private.automation_mode(new.workspace_id, new.project_id) = 'off' then
    raise exception 'Automation is off' using errcode = 'CP411';
  end if;
  return new;
end
$$;
revoke all on function contentpilot_private.guard_automation_off() from public, anon, authenticated, service_role;
create trigger sports_news_items_automation_off before insert on public.sports_news_items
for each row execute function contentpilot_private.guard_automation_off();

-- Window readers now expose the persistent flag (infinite end is reported as NULL).
drop function public.read_sports_auto_publish_control(uuid,uuid,uuid);
create function public.read_sports_auto_publish_control(p_workspace_id uuid,p_project_id uuid,p_destination_id uuid)
returns table(id uuid,starts_at timestamptz,ends_at timestamptz,max_per_slot integer,max_per_window integer,persistent boolean,max_per_day integer)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  return query select w.id,w.starts_at,nullif(w.ends_at,'infinity'::timestamptz),w.max_per_slot,w.max_per_window,w.persistent,w.max_per_day
    from contentpilot_private.sports_auto_publish_windows w
    where (w.workspace_id,w.project_id,w.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
      and w.starts_at <= clock_timestamp() and w.ends_at > clock_timestamp()
    order by w.starts_at desc limit 1;
end
$$;

drop function public.get_sports_auto_publish_window(uuid,uuid,uuid);
create function public.get_sports_auto_publish_window(p_workspace_id uuid, p_project_id uuid, p_destination_id uuid)
returns table(id uuid, starts_at timestamptz, ends_at timestamptz, persistent boolean)
language plpgsql security definer set search_path = '' as $$
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  if contentpilot_private.automation_mode(p_workspace_id,p_project_id) = 'off' then return; end if;
  return query
    select w.id, w.starts_at, nullif(w.ends_at,'infinity'::timestamptz), w.persistent
      from contentpilot_private.sports_auto_publish_windows w
      join public.publishing_destinations d on d.id = w.destination_id
     where (w.workspace_id,w.project_id,w.destination_id) = (p_workspace_id,p_project_id,p_destination_id)
       and w.starts_at <= clock_timestamp() and w.ends_at > clock_timestamp()
       and d.kind = 'telegram' and d.status = 'active'
       and (not w.persistent or contentpilot_private.automation_mode(p_workspace_id,p_project_id) = 'auto')
     order by w.starts_at desc limit 1;
end
$$;

drop function public.claim_sports_auto_publish(uuid,uuid,uuid,uuid);
create function public.claim_sports_auto_publish(p_workspace_id uuid,p_project_id uuid,p_destination_id uuid,p_post_id uuid)
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
      or n.assessment->>'rubricVersion' is distinct from 'sports-v1'
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

-- Off blocks every delivery claim for the destination (including human-approved ones) before any external call.
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
      and not exists (select 1 from contentpilot_private.sports_automation_modes m
        where m.workspace_id = p_workspace_id and m.destination_id = q.destination_id and m.mode = 'off')
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

revoke all on function public.get_sports_automation_mode(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.list_sports_automation_events(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.set_sports_automation_mode(uuid,uuid,uuid,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.read_sports_auto_publish_control(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.get_sports_auto_publish_window(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.claim_sports_auto_publish(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_sports_automation_mode(uuid,uuid) to authenticated;
grant execute on function public.list_sports_automation_events(uuid,uuid) to authenticated;
grant execute on function public.set_sports_automation_mode(uuid,uuid,uuid,text,integer) to authenticated;
grant execute on function public.read_sports_auto_publish_control(uuid,uuid,uuid) to authenticated;
grant execute on function public.get_sports_auto_publish_window(uuid,uuid,uuid) to authenticated;
grant execute on function public.claim_sports_auto_publish(uuid,uuid,uuid,uuid) to authenticated;

alter table contentpilot_private.sports_automation_modes enable row level security;
alter table contentpilot_private.sports_automation_events enable row level security;
revoke all on contentpilot_private.sports_automation_modes, contentpilot_private.sports_automation_events from public, anon, authenticated, service_role;

commit;
