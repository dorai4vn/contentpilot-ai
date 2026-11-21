-- ContentPilot AI — M4.6c: audit of AI agent publish requests.
--
-- The agent may now PROPOSE publishing (tool request_publish): it creates a
-- pending content_publish_requests row (request_source 'agent', agent_turn_id =
-- the server-generated turn id). This migration lets agent_actions record that,
-- with the same integrity guarantee as M3 writes: a "success" row can only
-- describe a request that really exists, was made by this user, by the agent,
-- in this very turn, for this post and version.
--
-- Changes (no previous migration is edited):
--   * agent_actions.kind accepts 'publish_request'.
--   * New column request_id, composite FK (workspace_id, request_id) so a row can
--     only reference a request of its own workspace. Granted for INSERT.
--   * A successful publish_request row must carry request_id, post_id and
--     version_after; at most one success row per request.
--   * The INSERT policy is replaced by one that keeps every M3 condition
--     unchanged and adds the check for publish_request success rows.
--   * request_id is immutable like every other column (append-only trigger).
--
-- Nothing here stores prompts, titles, bodies, reasons or credentials.

alter table public.agent_actions drop constraint agent_actions_kind_check;
alter table public.agent_actions add constraint agent_actions_kind_check
  check (kind in ('read', 'create', 'update', 'publish_request', 'unknown'));

alter table public.agent_actions add column request_id uuid;
alter table public.agent_actions
  add constraint agent_actions_request_fkey foreign key (workspace_id, request_id)
  references public.content_publish_requests (workspace_id, id) on delete restrict;

-- Only publish_request rows reference a request; a successful one must name it,
-- with the post and the requested version.
alter table public.agent_actions add constraint agent_actions_request_only_for_publish
  check (request_id is null or kind = 'publish_request');
alter table public.agent_actions add constraint agent_actions_publish_success_has_target
  check (
    status <> 'success' or kind <> 'publish_request'
    or (request_id is not null and post_id is not null and version_after is not null)
  );

create unique index agent_actions_one_success_per_publish_request
  on public.agent_actions (request_id)
  where status = 'success' and kind = 'publish_request';
create index agent_actions_request_idx on public.agent_actions (request_id) where request_id is not null;

grant insert (request_id) on table public.agent_actions to authenticated;

-- Append-only guard (replaces the M3 function; same rules, request_id included).
create or replace function public.agent_actions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.user_id is null
     and (new.id, new.workspace_id, new.turn_id, new.tool, new.kind, new.status, new.error_code,
          new.project_id, new.post_id, new.version_before, new.version_after, new.fields, new.created_at,
          new.request_id)
         is not distinct from
         (old.id, old.workspace_id, old.turn_id, old.tool, old.kind, old.status, old.error_code,
          old.project_id, old.post_id, old.version_before, old.version_after, old.fields, old.created_at,
          old.request_id) then
    return new;
  end if;
  raise exception 'Agent action log is append-only' using errcode = '42501';
end;
$$;

drop policy "Members can log their own agent actions" on public.agent_actions;

create policy "Members can log their own agent actions"
on public.agent_actions for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_workspace_member(workspace_id)
  and (
    -- M3 (unchanged): a successful write must match a real agent version written by this user.
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
  and (
    -- M4.6c: a successful publish request must match a real request made by the
    -- agent, for this user, in this turn, for this post and version.
    status <> 'success'
    or kind <> 'publish_request'
    or exists (
      select 1
      from public.content_publish_requests r
      where r.id = agent_actions.request_id
        and r.workspace_id = agent_actions.workspace_id
        and r.post_id = agent_actions.post_id
        and r.post_version = agent_actions.version_after
        and r.request_source = 'agent'
        and r.agent_turn_id = agent_actions.turn_id
        and r.requested_by = (select auth.uid())
    )
  )
);
