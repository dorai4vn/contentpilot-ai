-- ContentPilot AI — M3: audit log of AI agent tool calls (agent_actions).
--
-- What is stored: workspace, user, chat turn, tool name, outcome (status and
-- error code), the project/post involved, versions before/after and the time.
-- What is NOT stored: API keys, prompts, model replies, post titles or bodies,
-- tool arguments. Rows only contain ids, names and codes.
--
-- Security model
--   * RLS on; nothing granted to anon. Members of a workspace read its log.
--   * INSERT is column-restricted. user_id and created_at are set by a trigger
--     (auth.uid() / now()), never by the client. The insert policy requires
--     membership of the row's workspace and user_id = auth.uid().
--   * Referenced project/post must belong to the same workspace (composite
--     foreign keys), so a row cannot point into another workspace.
--   * A "success" row for a write (create/update) must match a real version in
--     content_post_versions written by this same user with change_source
--     'agent'; at most one success row per (post, version). The log therefore
--     cannot claim a write that did not happen.
--   * Append-only: no UPDATE/DELETE privilege or policy, and a trigger rejects
--     UPDATE/DELETE even for the table owner (except clearing user_id when the
--     account is deleted, via ON DELETE SET NULL).
--
-- No SECURITY DEFINER function is added: inserts run as the signed-in user
-- under RLS. Consequence (documented): a member could insert rows for
-- themselves through the API by hand; such rows can only be about their own
-- user and their own workspace, and can never claim a write that did not happen.

create table public.agent_actions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete restrict,
  user_id         uuid references auth.users (id) on delete set null,
  turn_id         uuid not null,
  tool            text not null check (tool ~ '^[a-z][a-z_]{0,39}$'),
  kind            text not null check (kind in ('read', 'create', 'update', 'unknown')),
  status          text not null check (status in ('success', 'error', 'skipped')),
  error_code      text check (error_code is null or error_code ~ '^[a-z][a-z_]{0,39}$'),
  project_id      uuid,
  post_id         uuid,
  version_before  integer check (version_before is null or version_before >= 1),
  version_after   integer check (version_after is null or version_after >= 1),
  fields          text[] check (fields is null or fields <@ array['title', 'body', 'scheduled_for']::text[]),
  created_at      timestamptz not null default now(),
  -- A referenced project/post always belongs to the row's workspace.
  constraint agent_actions_project_fkey foreign key (workspace_id, project_id)
    references public.content_projects (workspace_id, id) on delete restrict,
  constraint agent_actions_post_fkey foreign key (workspace_id, post_id)
    references public.content_posts (workspace_id, id) on delete restrict,
  -- Outcome consistency.
  constraint agent_actions_status_code check ((status = 'success') = (error_code is null)),
  constraint agent_actions_versions_order check (
    version_before is null or version_after is null or version_after > version_before
  ),
  constraint agent_actions_write_success_has_target check (
    status <> 'success' or kind not in ('create', 'update') or (post_id is not null and version_after is not null)
  ),
  constraint agent_actions_fields_only_for_updates check (fields is null or kind = 'update')
);

comment on table public.agent_actions is
  'Append-only log of AI agent tool calls: ids, outcome codes and versions only (no content, prompts or secrets).';

create index agent_actions_workspace_created_idx on public.agent_actions (workspace_id, created_at desc);
create index agent_actions_post_idx on public.agent_actions (post_id) where post_id is not null;
create index agent_actions_turn_idx on public.agent_actions (turn_id);

-- One success log per write: the same version cannot be claimed twice.
create unique index agent_actions_one_success_per_write
  on public.agent_actions (post_id, version_after)
  where status = 'success' and kind in ('create', 'update');

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- user_id and created_at come from the server context, never from the client.
create function public.agent_actions_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.user_id := (select auth.uid());
  if new.user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger agent_actions_before_insert
before insert on public.agent_actions
for each row execute function public.agent_actions_before_insert();

-- Append-only, even for the table owner, except clearing user_id when the
-- account is deleted (ON DELETE SET NULL).
create function public.agent_actions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.user_id is null
     and (new.id, new.workspace_id, new.turn_id, new.tool, new.kind, new.status, new.error_code,
          new.project_id, new.post_id, new.version_before, new.version_after, new.fields, new.created_at)
         is not distinct from
         (old.id, old.workspace_id, old.turn_id, old.tool, old.kind, old.status, old.error_code,
          old.project_id, old.post_id, old.version_before, old.version_after, old.fields, old.created_at) then
    return new;
  end if;
  raise exception 'Agent action log is append-only' using errcode = '42501';
end;
$$;

create trigger agent_actions_append_only
before update or delete on public.agent_actions
for each row execute function public.agent_actions_append_only();

revoke all on function public.agent_actions_before_insert() from public, anon, authenticated;
revoke all on function public.agent_actions_append_only() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Privileges (explicit: Supabase grants ALL on new tables by default)
-- ---------------------------------------------------------------------------

revoke all on table public.agent_actions from public, anon, authenticated;
grant select on table public.agent_actions to authenticated;
grant insert (
  workspace_id, turn_id, tool, kind, status, error_code,
  project_id, post_id, version_before, version_after, fields
) on table public.agent_actions to authenticated;
-- No UPDATE / DELETE: the log is append-only.

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.agent_actions enable row level security;

create policy "Members can view the agent log of their workspace"
on public.agent_actions for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "Members can log their own agent actions"
on public.agent_actions for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_workspace_member(workspace_id)
  and (
    -- A successful write must match a real agent version written by this user.
    status <> 'success'
    or kind not in ('create', 'update')
    or exists (
      select 1
      from public.content_post_versions v
      where v.post_id = agent_actions.post_id
        and v.workspace_id = agent_actions.workspace_id
        and v.version = agent_actions.version_after
        and v.change_source = 'agent'
        and v.changed_by = (select auth.uid())
    )
  )
);
