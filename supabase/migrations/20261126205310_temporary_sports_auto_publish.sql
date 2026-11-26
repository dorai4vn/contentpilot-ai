begin;

create table contentpilot_private.sports_auto_publish_windows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  destination_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  check (ends_at > starts_at and ends_at <= starts_at + interval '8 hours'),
  foreign key (workspace_id, project_id) references public.content_projects(workspace_id, id),
  foreign key (workspace_id, destination_id) references public.publishing_destinations(workspace_id, id)
);

create table contentpilot_private.sports_auto_publish_deliveries (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references contentpilot_private.sports_auto_publish_windows(id),
  request_id uuid not null unique references public.content_publish_requests(id),
  slot integer not null check (slot between 0 and 3),
  state text not null check (state in ('sending','succeeded','failed','uncertain')),
  external_id text,
  error_code text,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);
create index sports_auto_publish_deliveries_window_slot
  on contentpilot_private.sports_auto_publish_deliveries(window_id, slot);

-- Lock ordering is the same as a manual approval: post, then request.
-- A manual approval cannot queue a duplicate during or after an automatic send.
create function public.guard_sports_auto_publish_duplicate()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'pending' and new.status = 'approved' and exists (
    select 1 from contentpilot_private.sports_auto_publish_deliveries d
    join public.content_publish_requests auto_request on auto_request.id = d.request_id
    where (auto_request.post_id,auto_request.destination_id) = (old.post_id,old.destination_id) and d.state in ('sending','succeeded','uncertain')
  ) then
    raise exception 'Automatic Telegram delivery already attempted' using errcode = 'CP410';
  end if;
  return new;
end
$$;
revoke all on function public.guard_sports_auto_publish_duplicate() from public, anon, authenticated, service_role;
create trigger sports_auto_publish_duplicate_guard before update of status on public.content_publish_requests
for each row execute function public.guard_sports_auto_publish_duplicate();

create function public.get_sports_auto_publish_window(p_workspace_id uuid, p_project_id uuid, p_destination_id uuid)
returns table(id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  return query
    select w.id, w.starts_at, w.ends_at
      from contentpilot_private.sports_auto_publish_windows w
      join public.publishing_destinations d on d.id = w.destination_id
     where (w.workspace_id,w.project_id,w.destination_id) = (p_workspace_id,p_project_id,p_destination_id)
       and w.starts_at <= clock_timestamp() and w.ends_at > clock_timestamp()
       and d.kind = 'telegram' and d.status = 'active'
     order by w.starts_at desc limit 1;
end
$$;

create function public.claim_sports_auto_publish(p_workspace_id uuid,p_project_id uuid,p_destination_id uuid,p_post_id uuid)
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
  if (select count(*) from contentpilot_private.sports_auto_publish_deliveries a where a.window_id=w.id and a.slot=current_slot) >= 2
      or (select count(*) from contentpilot_private.sports_auto_publish_deliveries a where a.window_id=w.id) >= 8 then return; end if;
  insert into contentpilot_private.sports_auto_publish_deliveries(window_id,request_id,slot,state)
    values(w.id,r.id,current_slot,'sending') on conflict(request_id) do nothing returning sports_auto_publish_deliveries.id into delivery_id;
  if delivery_id is not null then return query select delivery_id,w.starts_at,w.ends_at,d.target_ref,p.created_at; end if;
end
$$;

create function public.finish_sports_auto_publish(p_workspace_id uuid,p_id uuid,p_external_id text,p_error_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.content_publish_requests; ambiguous boolean;
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  if (p_external_id is null) = (p_error_code is null)
     or (p_external_id is not null and p_external_id !~ '^[0-9]{1,20}$')
     or (p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,39}$') then
    raise exception 'Invalid delivery outcome' using errcode = '22023';
  end if;
  select req.* into r from public.content_publish_requests req
    join contentpilot_private.sports_auto_publish_deliveries a on a.request_id=req.id
    where a.id=p_id and req.workspace_id=p_workspace_id for update of req;
  if not found or r.requested_by is distinct from (select auth.uid()) then return false; end if;
  ambiguous := p_error_code = 'delivery_unconfirmed';
  update contentpilot_private.sports_auto_publish_deliveries a
     set state=case when p_external_id is not null then 'succeeded' when ambiguous then 'uncertain' else 'failed' end,
         external_id=p_external_id,error_code=p_error_code,completed_at=clock_timestamp()
   where a.id=p_id and a.request_id=r.id and a.state='sending';
  if not found then return false; end if;
  if r.status='pending' and (p_external_id is not null or ambiguous) then
    perform public.cancel_publish_request(r.id);
  end if;
  return true;
end
$$;

revoke all on function public.get_sports_auto_publish_window(uuid,uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_sports_auto_publish(uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.finish_sports_auto_publish(uuid,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.get_sports_auto_publish_window(uuid,uuid,uuid) to authenticated;
grant execute on function public.claim_sports_auto_publish(uuid,uuid,uuid,uuid) to authenticated;
grant execute on function public.finish_sports_auto_publish(uuid,uuid,text,text) to authenticated;

commit;
