-- FN09: configurable Auto Post cadence (owner-approved 2026-11-28).
--  * Defaults: daily quota 20, scan interval 2h, 2 distinct posts per scan across ALL feeds.
--  * Bounds: daily quota 1-120 (unchanged); scan interval 2-24h in whole 2h steps (the scheduler ticks every
--    2h, so a shorter or non-multiple interval could not be honoured); posts per scan 1-10 (AI draft budget is 10).
--  * Existing rows keep their daily_quota untouched (an explicit 40 and the old default 40 are indistinguishable:
--    the form always submitted a value, so nothing is overwritten and nothing is guessed). New rows default to 20.
--  * Existing rows get the new defaults for the two new settings (they were fixed constants before: 2h / 3 posts).
--  * begin_sports_scan() is the single DB-side scan gate: row-locked, so concurrent ticks never double scan.
--  * Interval changes never reset last_scan_at: the next scan is due last_scan_at + interval (minus 10 min jitter).
--  * Per-scan cap is accounted per stable scan identity (scan_seq), NOT per time slot derived from the interval.
--    Changing the interval never opens a new accounting slot; a changed cap applies prospectively to the open scan.
--  * Transient RSS failure (every feed unavailable) marks the scan 'failed'; begin_sports_scan then allows at most 2
--    retries, each no earlier than one scheduler tick (2h, minus jitter) after the last claim. Off / Emergency Stop clear it.
--  * Off default, emergency stop, approval semantics, Asia/Dubai day, and no backlog replay are unchanged.
begin;

alter table contentpilot_private.sports_automation_modes
  add column scan_interval_hours integer not null default 2
    check (scan_interval_hours between 2 and 24 and scan_interval_hours % 2 = 0),
  add column posts_per_scan integer not null default 2 check (posts_per_scan between 1 and 10),
  add column last_scan_at timestamptz,
  -- Stable scan identity: scan_seq increments once per real (non-retry) scan and never depends on the interval, so the
  -- per-scan cap cannot be bypassed by changing the interval mid-slot. A retry of a failed scan keeps the same seq.
  add column scan_seq integer not null default 0,
  add column scan_status text not null default 'done' check (scan_status in ('claimed','done','failed')),
  add column scan_retries integer not null default 0 check (scan_retries between 0 and 2),
  alter column daily_quota set default 20;
alter table contentpilot_private.sports_automation_events
  add column scan_interval_hours integer, add column posts_per_scan integer;
-- Open persistent windows follow the new per-scan default (history untouched).
update contentpilot_private.sports_auto_publish_windows set max_per_slot = 2 where persistent and ends_at > clock_timestamp();

drop function public.get_sports_automation_mode(uuid,uuid);
create function public.get_sports_automation_mode(p_workspace_id uuid, p_project_id uuid)
returns table(mode text, daily_quota integer, version integer, updated_at timestamptz, scan_interval_hours integer, posts_per_scan integer, last_scan_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  return query select m.mode, m.daily_quota, m.version, m.updated_at, m.scan_interval_hours, m.posts_per_scan, m.last_scan_at
    from contentpilot_private.sports_automation_modes m
    where (m.workspace_id, m.project_id) = (p_workspace_id, p_project_id);
  if not found then return query select 'off'::text, 20, 0, null::timestamptz, 2, 2, null::timestamptz; end if;
end
$$;
revoke all on function public.get_sports_automation_mode(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_sports_automation_mode(uuid,uuid) to authenticated;

drop function public.list_sports_automation_events(uuid,uuid);
create function public.list_sports_automation_events(p_workspace_id uuid, p_project_id uuid)
returns table(from_mode text, to_mode text, daily_quota integer, created_at timestamptz, scan_interval_hours integer, posts_per_scan integer)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  return query select e.from_mode, e.to_mode, e.daily_quota, e.created_at, e.scan_interval_hours, e.posts_per_scan
    from contentpilot_private.sports_automation_events e
    where (e.workspace_id, e.project_id) = (p_workspace_id, p_project_id)
    order by e.created_at desc limit 20;
end
$$;
revoke all on function public.list_sports_automation_events(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_sports_automation_events(uuid,uuid) to authenticated;

-- NULL interval / posts keep the stored value (or the default when no row exists). Same-mode Auto edits update the
-- open window in place (no new window, so in-flight eligible drafts are not dropped and nothing is replayed).
drop function public.set_sports_automation_mode(uuid,uuid,uuid,text,integer);
create function public.set_sports_automation_mode(
  p_workspace_id uuid, p_project_id uuid, p_destination_id uuid, p_mode text, p_daily_quota integer,
  p_scan_interval_hours integer default null, p_posts_per_scan integer default null
) returns integer language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz; v_old text; v_version integer; v_interval integer; v_posts integer; v_updated integer;
begin
  if not public.has_workspace_role(p_workspace_id, array['owner','admin']::public.workspace_role[]) then
    raise exception 'Only Owner/Admin can change automation' using errcode = '42501';
  end if;
  select coalesce(p_scan_interval_hours, m.scan_interval_hours, 2), coalesce(p_posts_per_scan, m.posts_per_scan, 2)
    into v_interval, v_posts
    from (select 1) x left join contentpilot_private.sports_automation_modes m
      on (m.workspace_id, m.project_id) = (p_workspace_id, p_project_id);
  if p_mode is null or p_mode not in ('off','semi','auto') or p_daily_quota is null or p_daily_quota not between 1 and 120
     or v_interval not between 2 and 24 or v_interval % 2 <> 0 or v_posts not between 1 and 10 then
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
  v_updated := 0;
  if p_mode = 'auto' and v_old = 'auto' then
    update contentpilot_private.sports_auto_publish_windows w
       set max_per_slot = v_posts, max_per_day = p_daily_quota
     where (w.workspace_id,w.project_id,w.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
       and w.persistent and w.starts_at <= v_now and w.ends_at > v_now;
    get diagnostics v_updated = row_count;
  end if;
  if v_updated = 0 then
    update contentpilot_private.sports_auto_publish_windows w
       set ends_at = v_now, stopped_by = (select auth.uid())
     where (w.workspace_id,w.project_id,w.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
       and w.starts_at < v_now and w.ends_at > v_now;
    if p_mode = 'auto' then
      insert into contentpilot_private.sports_auto_publish_windows
        (workspace_id,project_id,destination_id,starts_at,ends_at,persistent,max_per_slot,max_per_window,max_per_day)
      values (p_workspace_id,p_project_id,p_destination_id,v_now,'infinity',true,v_posts,40,p_daily_quota);
    end if;
  end if;
  insert into contentpilot_private.sports_automation_modes as m
    (workspace_id,project_id,destination_id,mode,daily_quota,scan_interval_hours,posts_per_scan,updated_by,updated_at)
  values (p_workspace_id,p_project_id,p_destination_id,p_mode,p_daily_quota,v_interval,v_posts,(select auth.uid()),v_now)
  on conflict (workspace_id,project_id) do update
    set destination_id=excluded.destination_id, mode=excluded.mode, daily_quota=excluded.daily_quota,
        scan_interval_hours=excluded.scan_interval_hours, posts_per_scan=excluded.posts_per_scan,
        scan_status=case when excluded.mode='off' then 'done' else m.scan_status end,
        scan_retries=case when excluded.mode='off' then 0 else m.scan_retries end,
        version=m.version+1, updated_by=excluded.updated_by, updated_at=excluded.updated_at
  returning m.version into v_version;
  insert into contentpilot_private.sports_automation_events
    (workspace_id,project_id,from_mode,to_mode,daily_quota,scan_interval_hours,posts_per_scan,actor,created_at)
  values (p_workspace_id,p_project_id,v_old,p_mode,p_daily_quota,v_interval,v_posts,(select auth.uid()),v_now);
  return v_version;
end
$$;
revoke all on function public.set_sports_automation_mode(uuid,uuid,uuid,text,integer,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.set_sports_automation_mode(uuid,uuid,uuid,text,integer,integer,integer) to authenticated;

-- Scan gate. Row-locked: of N concurrent ticks exactly one gets due=true. Off/unconfigured is never due.
-- A scan whose RSS collection failed (scan_status='failed') may be retried at most twice, each no sooner than one
-- scheduler tick (2h) after the previous claim, and keeps its scan_seq (so the per-scan cap is not doubled).
create function public.begin_sports_scan(p_workspace_id uuid, p_project_id uuid)
returns table(due boolean, posts_per_scan integer, scan_interval_hours integer, is_retry boolean)
language plpgsql security definer set search_path = '' as $$
declare m contentpilot_private.sports_automation_modes; v_now timestamptz := clock_timestamp(); v_regular boolean; v_retry boolean;
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  select * into m from contentpilot_private.sports_automation_modes x
    where (x.workspace_id, x.project_id) = (p_workspace_id, p_project_id) for update;
  if not found or m.mode not in ('semi','auto') then return query select false, 2, 2, false; return; end if;
  -- 10 minutes of scheduler jitter are tolerated so a slightly early tick is not skipped for a whole interval.
  v_regular := m.last_scan_at is null
    or v_now >= m.last_scan_at + make_interval(hours => m.scan_interval_hours) - interval '10 minutes';
  v_retry := not v_regular and m.scan_status = 'failed' and m.scan_retries < 2
    and v_now >= m.last_scan_at + interval '2 hours' - interval '10 minutes';
  if not v_regular and not v_retry then
    return query select false, m.posts_per_scan, m.scan_interval_hours, false; return;
  end if;
  if v_regular then
    update contentpilot_private.sports_automation_modes x
       set last_scan_at = v_now, scan_seq = x.scan_seq + 1, scan_status = 'claimed', scan_retries = 0
     where (x.workspace_id, x.project_id) = (p_workspace_id, p_project_id);
  else
    update contentpilot_private.sports_automation_modes x
       set last_scan_at = v_now, scan_status = 'claimed', scan_retries = x.scan_retries + 1
     where (x.workspace_id, x.project_id) = (p_workspace_id, p_project_id);
  end if;
  return query select true, m.posts_per_scan, m.scan_interval_hours, v_retry;
end
$$;
revoke all on function public.begin_sports_scan(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.begin_sports_scan(uuid,uuid) to authenticated;

-- Reports the outcome of RSS collection for the claimed scan. ok=true (including a successful EMPTY scan) closes it;
-- ok=false (every feed unavailable / collection threw) makes it retryable. Only a 'claimed' scan can transition, and
-- Off / Emergency Stop always close it, so nothing is retried after the switch.
create function public.finish_sports_scan(p_workspace_id uuid, p_project_id uuid, p_ok boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare m contentpilot_private.sports_automation_modes;
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  select * into m from contentpilot_private.sports_automation_modes x
    where (x.workspace_id, x.project_id) = (p_workspace_id, p_project_id) for update;
  if not found or m.scan_status <> 'claimed' then return; end if;
  update contentpilot_private.sports_automation_modes x
     set scan_status = case when p_ok or m.mode not in ('semi','auto') then 'done' else 'failed' end
   where (x.workspace_id, x.project_id) = (p_workspace_id, p_project_id);
end
$$;
revoke all on function public.finish_sports_scan(uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.finish_sports_scan(uuid,uuid,boolean) to authenticated;

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
  cfg contentpilot_private.sports_automation_modes;
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
    -- Slot = scan identity (scan_seq); the quota is per Dubai day across every persistent window of the destination.
    -- FN09: posts per scan, scan identity and daily cap come from the persisted mode row (hard caps, not labels).
    select * into cfg from contentpilot_private.sports_automation_modes mm
      where (mm.workspace_id,mm.project_id)=(p_workspace_id,p_project_id);
    if not found then return; end if;
    current_slot := cfg.scan_seq; -- stable scan identity, independent of the interval
    if (select count(*) from contentpilot_private.sports_auto_publish_deliveries a
          join contentpilot_private.sports_auto_publish_windows aw on aw.id=a.window_id
         where (aw.workspace_id,aw.project_id,aw.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
           and a.slot=current_slot) >= cfg.posts_per_scan
       or (select count(*) from contentpilot_private.sports_auto_publish_deliveries a
          join contentpilot_private.sports_auto_publish_windows aw on aw.id=a.window_id
         where (aw.workspace_id,aw.project_id,aw.destination_id)=(p_workspace_id,p_project_id,p_destination_id)
           and (a.started_at at time zone 'Asia/Dubai')::date=(t at time zone 'Asia/Dubai')::date) >= cfg.daily_quota then return; end if;
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

revoke all on function public.claim_sports_auto_publish(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_sports_auto_publish(uuid,uuid,uuid,uuid) to authenticated;

commit;
