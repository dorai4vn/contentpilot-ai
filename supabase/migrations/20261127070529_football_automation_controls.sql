begin;

alter table contentpilot_private.sports_auto_publish_windows
  add column max_per_slot integer not null default 10 check (max_per_slot between 1 and 10),
  add column max_per_window integer not null default 40 check (max_per_window between 1 and 40),
  add column stopped_by uuid references auth.users(id),
  add constraint sports_auto_window_quota_order check (max_per_window >= max_per_slot);

create function public.read_sports_auto_publish_control(p_workspace_id uuid,p_project_id uuid,p_destination_id uuid)
returns table(id uuid,starts_at timestamptz,ends_at timestamptz,max_per_slot integer,max_per_window integer)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  return query select w.id,w.starts_at,w.ends_at,w.max_per_slot,w.max_per_window
    from contentpilot_private.sports_auto_publish_windows w
    where (w.workspace_id,w.project_id,w.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
      and w.starts_at <= clock_timestamp() and w.ends_at > clock_timestamp()
    order by w.starts_at desc limit 1;
end
$$;

create function public.set_sports_auto_publish_control(
  p_workspace_id uuid,p_project_id uuid,p_destination_id uuid,p_enabled boolean,
  p_hours integer,p_slot_limit integer,p_window_limit integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz;
begin
  if not public.has_workspace_role(p_workspace_id,array['owner','admin']::public.workspace_role[]) then
    raise exception 'Only Owner/Admin can change automation' using errcode = '42501';
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

revoke all on function public.read_sports_auto_publish_control(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.set_sports_auto_publish_control(uuid,uuid,uuid,boolean,integer,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_sports_auto_publish_control(uuid,uuid,uuid) to authenticated;
grant execute on function public.set_sports_auto_publish_control(uuid,uuid,uuid,boolean,integer,integer,integer) to authenticated;

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
      or coalesce(n.assessment->>'decision','') not in ('threshold_met','highest_below_threshold') then return; end if;
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
