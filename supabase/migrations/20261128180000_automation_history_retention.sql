-- FN10: Auto Post "Lịch sử thao tác" shows the newest 5 events per workspace/project. Older rows are HIDDEN (hidden_at
-- is persisted server-side) and purged 30 days after they were hidden. The latest five are never purged, whatever
-- their age. Only contentpilot_private.sports_automation_events is touched: publishing history, delivery logs and
-- every other audit table are unrelated and unchanged.

begin;

alter table contentpilot_private.sports_automation_events
  add column hidden_at timestamptz,
  add column seq bigint;

-- Deterministic order for events that share a created_at: seq (monotonic, assigned at insert). Existing rows get a
-- stable (created_at, id) order.
update contentpilot_private.sports_automation_events e set seq = r.n
  from (select id, row_number() over (order by created_at, id) as n from contentpilot_private.sports_automation_events) r
  where e.id = r.id;
create sequence contentpilot_private.sports_automation_events_seq owned by contentpilot_private.sports_automation_events.seq;
select setval('contentpilot_private.sports_automation_events_seq',
  coalesce((select max(seq) from contentpilot_private.sports_automation_events), 0) + 1, false);
alter table contentpilot_private.sports_automation_events
  alter column seq set default nextval('contentpilot_private.sports_automation_events_seq'),
  alter column seq set not null;
create unique index sports_automation_events_seq_key on contentpilot_private.sports_automation_events(seq);
create index sports_automation_events_rank
  on contentpilot_private.sports_automation_events(workspace_id, project_id, created_at desc, seq desc);
create index sports_automation_events_hidden
  on contentpilot_private.sports_automation_events(hidden_at) where hidden_at is not null;

-- Ranks one scope: rows outside the newest 5 get hidden_at (kept if already set), rows inside it are visible.
-- Serialised per scope with a transaction advisory lock, so concurrent inserts rank atomically: the later
-- transaction re-reads (READ COMMITTED) after the earlier one committed.
create function contentpilot_private.rank_sports_automation_events(p_workspace_id uuid, p_project_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('sports_automation_events:' || p_workspace_id::text || ':' || p_project_id::text, 0));
  update contentpilot_private.sports_automation_events e
     set hidden_at = case when r.rn > 5 then coalesce(e.hidden_at, clock_timestamp()) else null end
    from (select x.id, row_number() over (order by x.created_at desc, x.seq desc) as rn
            from contentpilot_private.sports_automation_events x
           where (x.workspace_id, x.project_id) = (p_workspace_id, p_project_id)) r
   where e.id = r.id
     and e.hidden_at is distinct from case when r.rn > 5 then coalesce(e.hidden_at, clock_timestamp()) else null end;
end
$$;
revoke all on function contentpilot_private.rank_sports_automation_events(uuid,uuid) from public, anon, authenticated, service_role;

create function contentpilot_private.sports_automation_events_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform contentpilot_private.rank_sports_automation_events(new.workspace_id, new.project_id);
  return null;
end
$$;
revoke all on function contentpilot_private.sports_automation_events_after_insert() from public, anon, authenticated, service_role;
create trigger sports_automation_events_rank_after_insert
  after insert on contentpilot_private.sports_automation_events
  for each row execute function contentpilot_private.sports_automation_events_after_insert();

-- Backfill: preexisting excess rows start their 30-day retention NOW (migration time); nothing is deleted here.
do $$
declare s record;
begin
  for s in select distinct workspace_id, project_id from contentpilot_private.sports_automation_events loop
    perform contentpilot_private.rank_sports_automation_events(s.workspace_id, s.project_id);
  end loop;
end $$;

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
    where (e.workspace_id, e.project_id) = (p_workspace_id, p_project_id) and e.hidden_at is null
    order by e.created_at desc, e.seq desc limit 5;
end
$$;
revoke all on function public.list_sports_automation_events(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_sports_automation_events(uuid,uuid) to authenticated;

-- Purge: only rows HIDDEN for >= 30 days, only in the given scope, never a row inside the newest 5.
-- The private variant takes the clock so the exact boundary is testable; the public wrapper always uses the real
-- clock (a caller can never purge early) and is worker-only, like begin_sports_scan.
create function contentpilot_private.purge_sports_automation_events(p_workspace_id uuid, p_project_id uuid, p_now timestamptz)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_deleted integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('sports_automation_events:' || p_workspace_id::text || ':' || p_project_id::text, 0));
  delete from contentpilot_private.sports_automation_events e
   where (e.workspace_id, e.project_id) = (p_workspace_id, p_project_id)
     and e.hidden_at is not null
     and e.hidden_at <= p_now - interval '30 days'
     and e.id not in (select x.id from contentpilot_private.sports_automation_events x
                       where (x.workspace_id, x.project_id) = (p_workspace_id, p_project_id)
                       order by x.created_at desc, x.seq desc limit 5);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;
revoke all on function contentpilot_private.purge_sports_automation_events(uuid,uuid,timestamptz) from public, anon, authenticated, service_role;

create function public.purge_sports_automation_history(p_workspace_id uuid, p_project_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;
  return contentpilot_private.purge_sports_automation_events(p_workspace_id, p_project_id, clock_timestamp());
end
$$;
revoke all on function public.purge_sports_automation_history(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.purge_sports_automation_history(uuid,uuid) to authenticated;

commit;
