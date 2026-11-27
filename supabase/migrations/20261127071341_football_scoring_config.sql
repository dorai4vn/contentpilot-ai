begin;

create table public.sports_news_scoring_configs (
  workspace_id uuid not null,
  project_id uuid primary key,
  version integer not null default 1 check (version > 0),
  threshold numeric(3,1) not null default 8.0 check (threshold between 0 and 10),
  reach_weight integer not null default 45 check (reach_weight between 0 and 100),
  importance_weight integer not null default 40 check (importance_weight between 0 and 100),
  freshness_weight integer not null default 15 check (freshness_weight between 0 and 100),
  fallback_mode text not null default 'highest' check (fallback_mode in ('highest','strict')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id,project_id) references public.content_projects(workspace_id,id) on delete cascade,
  check (reach_weight + importance_weight + freshness_weight = 100)
);

alter table public.sports_news_scoring_configs enable row level security;
revoke all on public.sports_news_scoring_configs from public,anon,authenticated,service_role;
grant select on public.sports_news_scoring_configs to authenticated;
create policy sports_scoring_member_read on public.sports_news_scoring_configs for select to authenticated
using (public.is_workspace_member(workspace_id));

create function public.set_sports_news_scoring_config(
  p_workspace_id uuid,p_project_id uuid,p_threshold numeric,p_reach_weight integer,
  p_importance_weight integer,p_freshness_weight integer,p_fallback_mode text
) returns integer language plpgsql security definer set search_path = '' as $$
declare new_version integer;
begin
  if not public.has_workspace_role(p_workspace_id,array['owner','admin']::public.workspace_role[]) then
    raise exception 'Only Owner/Admin can change scoring' using errcode = '42501';
  end if;
  if p_threshold is null or p_threshold < 0 or p_threshold > 10 or p_threshold * 10 <> trunc(p_threshold * 10)
    or p_reach_weight is null or p_importance_weight is null or p_freshness_weight is null
    or p_reach_weight < 0 or p_importance_weight < 0 or p_freshness_weight < 0
    or p_reach_weight + p_importance_weight + p_freshness_weight <> 100
    or p_fallback_mode not in ('highest','strict') or p_fallback_mode is null then
    raise exception 'Invalid scoring configuration' using errcode = '22023';
  end if;
  perform 1 from public.content_projects p where (p.workspace_id,p.id)=(p_workspace_id,p_project_id)
    and p.archived_at is null;
  if not found then raise exception 'Project unavailable' using errcode = '22023'; end if;
  insert into public.sports_news_scoring_configs
    (workspace_id,project_id,threshold,reach_weight,importance_weight,freshness_weight,fallback_mode,updated_by)
  values(p_workspace_id,p_project_id,p_threshold,p_reach_weight,p_importance_weight,p_freshness_weight,p_fallback_mode,(select auth.uid()))
  on conflict(project_id) do update set
    version=public.sports_news_scoring_configs.version+1,
    threshold=excluded.threshold,
    reach_weight=excluded.reach_weight,
    importance_weight=excluded.importance_weight,
    freshness_weight=excluded.freshness_weight,
    fallback_mode=excluded.fallback_mode,
    updated_by=excluded.updated_by,
    updated_at=clock_timestamp()
  where public.sports_news_scoring_configs.workspace_id=p_workspace_id
  returning version into new_version;
  if new_version is null then raise exception 'Workspace mismatch' using errcode = '42501'; end if;
  return new_version;
end
$$;
revoke all on function public.set_sports_news_scoring_config(uuid,uuid,numeric,integer,integer,integer,text)
  from public,anon,authenticated,service_role;
grant execute on function public.set_sports_news_scoring_config(uuid,uuid,numeric,integer,integer,integer,text)
  to authenticated;

commit;
