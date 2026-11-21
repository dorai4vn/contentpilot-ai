-- ContentPilot AI — M4.6a: publishing destinations and delivery records.
-- Architecture: docs/architecture/publishing.md
--
-- Separates four concerns:
--   Content      content_posts / content_post_versions (unchanged)
--   Approval     content_publish_requests: one request = one post version for ONE destination
--   Destination  publishing_destinations: where a post may be published (per workspace)
--   Execution    publish_deliveries: the outcome of publishing an approved request
--
-- Scope of this migration (M4.6a)
--   * Only the 'internal' destination kind exists (CHECK). Every workspace has
--     exactly one internal destination: backfilled here and created by a trigger
--     for new workspaces. External kinds (Telegram, Discord, Facebook…) will each
--     be enabled by their own migration in M5, together with credentials storage.
--   * No credentials, tokens or secrets are stored anywhere in these tables.
--   * No worker and no external API call: approving an internal request still
--     publishes the post in the same transaction (unchanged M4 behaviour) and
--     records a 'succeeded' delivery. A request for a non-internal destination
--     (impossible until M5) would only create a 'queued' delivery.
--
-- Compatibility with M4.1 – M4.5 (no previous migration is edited)
--   * Existing requests are backfilled to their workspace's internal destination.
--   * request_post_publish gains a LAST parameter p_destination_id DEFAULT NULL.
--     Existing callers (named arguments, M4.2 data layer / M4.4 actions) keep
--     working and get the internal destination, never an external one. An agent
--     request (p_source = 'agent') must name its destination explicitly.
--   * approve_publish_request gains a LAST parameter p_expected_destination_id
--     DEFAULT NULL. When given, it must match the request's destination (CP409).
--     M4.6b passes it from the UI so the approver confirms the destination too.
--   * The publish guard on content_posts now also requires the approved request's
--     destination to be internal: only an internal approval changes the post status.
--
-- New error code: CP426 destination disabled.
--
-- SECURITY DEFINER functions added or replaced here (search_path = '', no
-- caller-supplied user id, EXECUTE revoked from public/anon):
--   * create_internal_publishing_destination(): trigger on workspaces; nobody may call it.
--   * request_post_publish / approve_publish_request: replaced (see above).

-- ---------------------------------------------------------------------------
-- publishing_destinations
-- ---------------------------------------------------------------------------

create table public.publishing_destinations (
  id            uuid primary key default gen_random_uuid(),
  -- Deleting a workspace removes its destinations. A workspace that still has
  -- content cannot be deleted anyway (content FKs are ON DELETE RESTRICT).
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  kind          text not null check (kind in ('internal')),
  name          text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  -- Public identifier of the external target (chat / channel / page id). Never a secret.
  target_ref    text check (target_ref is null or char_length(target_ref) between 1 and 200),
  status        text not null default 'active' check (status in ('active', 'disabled')),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint publishing_destinations_workspace_id_id_key unique (workspace_id, id),
  constraint publishing_destinations_internal_no_target check (kind <> 'internal' or target_ref is null)
);

comment on table public.publishing_destinations is
  'Where posts of a workspace may be published. Only kind internal for now. No credentials here.';

-- Exactly one internal destination per workspace.
create unique index publishing_destinations_one_internal
  on public.publishing_destinations (workspace_id) where kind = 'internal';

create function public.publishing_destinations_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    new.created_at := now();
  else
    if (new.id, new.workspace_id, new.kind, new.created_at) is distinct from (old.id, old.workspace_id, old.kind, old.created_at)
       or (new.created_by is distinct from old.created_by and new.created_by is not null) then
      raise exception 'Destination identity cannot be changed' using errcode = '42501';
    end if;
    -- The internal destination is permanent: it cannot be disabled or retargeted.
    if old.kind = 'internal'
       and (new.status, new.target_ref) is distinct from (old.status, old.target_ref) then
      raise exception 'The internal destination cannot be disabled or retargeted' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger publishing_destinations_before_write
before insert or update on public.publishing_destinations
for each row execute function public.publishing_destinations_before_write();

-- Backfill: one internal destination for every existing workspace.
insert into public.publishing_destinations (workspace_id, kind, name)
select w.id, 'internal', 'Nội bộ'
from public.workspaces w
where not exists (
  select 1 from public.publishing_destinations d where d.workspace_id = w.id and d.kind = 'internal'
);

-- New workspaces get their internal destination atomically.
-- SECURITY DEFINER: the creator has no INSERT path for the internal destination.
create function public.create_internal_publishing_destination()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.publishing_destinations (workspace_id, kind, name)
  values (new.id, 'internal', 'Nội bộ');
  return null;
end;
$$;

create trigger workspaces_create_internal_destination
after insert on public.workspaces
for each row execute function public.create_internal_publishing_destination();

-- ---------------------------------------------------------------------------
-- content_publish_requests: one destination per request
-- ---------------------------------------------------------------------------

alter table public.content_publish_requests add column destination_id uuid;

-- Backfill: every existing request targeted the internal destination. Only
-- destination_id changes; the guard trigger allows it (status unchanged) and the
-- audit trigger records nothing (no status change).
update public.content_publish_requests r
   set destination_id = d.id
  from public.publishing_destinations d
 where d.workspace_id = r.workspace_id
   and d.kind = 'internal'
   and r.destination_id is null;

alter table public.content_publish_requests alter column destination_id set not null;
alter table public.content_publish_requests
  add constraint content_publish_requests_destination_fkey foreign key (workspace_id, destination_id)
  references public.publishing_destinations (workspace_id, id) on delete restrict;

-- One pending request per (post, destination); one approval per (post, destination, version).
drop index public.content_publish_requests_one_pending;
create unique index content_publish_requests_one_pending
  on public.content_publish_requests (post_id, destination_id) where status = 'pending';
drop index public.content_publish_requests_one_approval_per_version;
create unique index content_publish_requests_one_approval_per_version
  on public.content_publish_requests (post_id, destination_id, post_version) where status = 'approved';
create index content_publish_requests_destination_idx on public.content_publish_requests (destination_id);

-- The destination of a request is immutable (replaces the M4.1 guard; same rules plus destination_id).
create or replace function public.content_publish_requests_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Publish requests cannot be deleted' using errcode = '42501';
  end if;

  if (new.id, new.workspace_id, new.post_id, new.post_version, new.request_source, new.agent_turn_id,
      new.reason, new.requested_at, new.expires_at, new.destination_id)
     is distinct from
     (old.id, old.workspace_id, old.post_id, old.post_version, old.request_source, old.agent_turn_id,
      old.reason, old.requested_at, old.expires_at, old.destination_id)
     or (new.requested_by is distinct from old.requested_by and new.requested_by is not null) then
    raise exception 'Publish request identity cannot be changed' using errcode = '42501';
  end if;

  if new.status = old.status then
    if (new.decided_at, new.decision_note, new.cancel_reason) is distinct from
       (old.decided_at, old.decision_note, old.cancel_reason)
       or (new.decided_by is distinct from old.decided_by and new.decided_by is not null) then
      raise exception 'Publish request decision cannot be changed' using errcode = 'CP410';
    end if;
    return new;
  end if;

  if old.status <> 'pending' then
    raise exception 'Publish request was already decided' using errcode = 'CP410';
  end if;

  new.decided_by := (select auth.uid());
  new.decided_at := now();
  if new.decided_by is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- publish_deliveries: execution, separate from approval
-- ---------------------------------------------------------------------------

create table public.publish_deliveries (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  request_id        uuid not null,
  destination_id    uuid not null,
  post_id           uuid not null,
  post_version      integer not null check (post_version >= 1),
  status            text not null check (status in ('queued', 'sending', 'succeeded', 'failed', 'cancelled')),
  attempt_count     integer not null default 0 check (attempt_count >= 0),
  next_attempt_at   timestamptz,
  -- Id of the post on the external platform (public identifier, never a secret).
  external_post_id  text check (external_post_id is null or char_length(external_post_id) between 1 and 200),
  -- Our own safe error code only: never the platform's message, payload or token.
  last_error_code   text check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- Prevents publishing one approval twice (derived from the request id).
  idempotency_key   text not null check (char_length(idempotency_key) between 1 and 100),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint publish_deliveries_request_fkey foreign key (workspace_id, request_id)
    references public.content_publish_requests (workspace_id, id) on delete restrict,
  constraint publish_deliveries_destination_fkey foreign key (workspace_id, destination_id)
    references public.publishing_destinations (workspace_id, id) on delete restrict,
  constraint publish_deliveries_post_fkey foreign key (workspace_id, post_id)
    references public.content_posts (workspace_id, id) on delete restrict,
  constraint publish_deliveries_one_per_request unique (request_id),
  constraint publish_deliveries_idempotency_key unique (idempotency_key),
  constraint publish_deliveries_completed check ((status in ('succeeded', 'failed', 'cancelled')) = (completed_at is not null)),
  constraint publish_deliveries_external_id_only_on_success check (external_post_id is null or status = 'succeeded')
);

comment on table public.publish_deliveries is
  'Execution of an approved publish request on its destination (status, retries, external id). No credentials.';

create index publish_deliveries_workspace_idx on public.publish_deliveries (workspace_id, created_at desc);
create index publish_deliveries_queue_idx on public.publish_deliveries (status, next_attempt_at)
  where status in ('queued', 'failed');

-- A delivery must belong to an APPROVED request and copy its destination, post and
-- version exactly. Identity is immutable; finished deliveries are final.
create function public.publish_deliveries_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_request public.content_publish_requests;
begin
  if tg_op = 'DELETE' then
    raise exception 'Publish deliveries cannot be deleted' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    select * into v_request from public.content_publish_requests r where r.id = new.request_id;
    if not found
       or v_request.status <> 'approved'
       or (v_request.workspace_id, v_request.destination_id, v_request.post_id, v_request.post_version)
          is distinct from (new.workspace_id, new.destination_id, new.post_id, new.post_version) then
      raise exception 'A delivery needs an approved request for the same destination, post and version'
        using errcode = '42501';
    end if;
    if new.idempotency_key is distinct from 'request:' || new.request_id::text then
      raise exception 'Invalid idempotency key' using errcode = '22023';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if (new.id, new.workspace_id, new.request_id, new.destination_id, new.post_id, new.post_version,
      new.idempotency_key, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.request_id, old.destination_id, old.post_id, old.post_version,
      old.idempotency_key, old.created_at) then
    raise exception 'Delivery identity cannot be changed' using errcode = '42501';
  end if;
  if old.status in ('succeeded', 'cancelled') then
    raise exception 'A finished delivery cannot be changed' using errcode = '42501';
  end if;
  if new.attempt_count < old.attempt_count then
    raise exception 'attempt_count cannot decrease' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger publish_deliveries_guard
before insert or update or delete on public.publish_deliveries
for each row execute function public.publish_deliveries_guard();

-- ---------------------------------------------------------------------------
-- Publish guard on content_posts (replaces the M4.1 function; same rules, plus:
-- only an approval for the INTERNAL destination may change the post status).
-- ---------------------------------------------------------------------------

create or replace function public.content_posts_guard_publish()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'published' then
      raise exception 'Publishing requires an approved publish request' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status = 'published' then
    if (new.title, new.body, new.status, new.scheduled_for, new.archived_at, new.published_at, new.last_change_source)
       is distinct from
       (old.title, old.body, old.status, old.scheduled_for, old.archived_at, old.published_at, old.last_change_source) then
      raise exception 'Published posts cannot be changed' using errcode = 'CP422';
    end if;
    return new;
  end if;

  if new.status = 'published' then
    if (new.title, new.body, new.scheduled_for, new.archived_at)
       is distinct from (old.title, old.body, old.scheduled_for, old.archived_at)
       or old.archived_at is not null then
      raise exception 'Publishing requires an approved publish request' using errcode = '42501';
    end if;
    if (select auth.uid()) is null or not exists (
      select 1
      from public.content_publish_requests r
      join public.publishing_destinations d
        on d.id = r.destination_id and d.workspace_id = r.workspace_id
      where r.post_id = new.id
        and r.workspace_id = new.workspace_id
        and r.post_version = old.version
        and r.status = 'approved'
        and r.decided_by = (select auth.uid())
        and r.decided_at = now()  -- approved in this very transaction
        and d.kind = 'internal'   -- only an internal approval changes the post status
    ) then
      raise exception 'Publishing requires an approved publish request' using errcode = '42501';
    end if;
    new.published_at := now();
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPCs (replaced: one new LAST parameter each, with a default; see header)
-- ---------------------------------------------------------------------------

drop function public.request_post_publish(uuid, integer, public.content_change_source, uuid, text);

create function public.request_post_publish(
  p_post_id uuid,
  p_expected_version integer,
  p_source public.content_change_source default 'user',
  p_agent_turn_id uuid default null,
  p_reason text default null,
  p_destination_id uuid default null
)
returns public.content_publish_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.content_posts;
  v_destination public.publishing_destinations;
  v_request public.content_publish_requests;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if p_source is null then
    raise exception 'source is required' using errcode = '22023';
  end if;
  if (p_source = 'agent') <> (p_agent_turn_id is not null) then
    raise exception 'agent requests need a turn id, user requests none' using errcode = '22023';
  end if;
  if public.publish_caller_is_agent() and p_source <> 'agent' then
    raise exception 'Agent requests must be marked as agent requests' using errcode = '42501';
  end if;
  -- The agent must always name the destination; only legacy user calls default to internal.
  if p_source = 'agent' and p_destination_id is null then
    raise exception 'agent requests must name a destination' using errcode = '22023';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'reason is too long' using errcode = '22023';
  end if;

  -- Authentication, membership (CP404), row lock and expected version (CP409).
  v_post := public.lock_content_post_for_write(p_post_id, p_expected_version);

  -- Destination: the given one, or (legacy callers) the workspace's internal one.
  -- It must belong to the post's workspace, else it does not exist for this post.
  if p_destination_id is null then
    select * into v_destination from public.publishing_destinations d
     where d.workspace_id = v_post.workspace_id and d.kind = 'internal';
  else
    select * into v_destination from public.publishing_destinations d
     where d.id = p_destination_id and d.workspace_id = v_post.workspace_id;
  end if;
  if not found then
    raise exception 'Publishing destination not found' using errcode = 'CP404';
  end if;
  if v_destination.status <> 'active' then
    raise exception 'Publishing destination is disabled' using errcode = 'CP426';
  end if;

  if v_post.status = 'published' then
    raise exception 'Content post is already published' using errcode = 'CP422';
  end if;
  if v_post.archived_at is not null
     or exists (
       select 1 from public.content_projects pr
       where pr.id = v_post.project_id and pr.archived_at is not null
     ) then
    raise exception 'Content post is archived' using errcode = 'CP423';
  end if;

  -- An expired pending request for this post and destination no longer blocks a new one.
  update public.content_publish_requests r
     set status = 'cancelled', cancel_reason = 'expired'
   where r.post_id = v_post.id and r.destination_id = v_destination.id
     and r.status = 'pending' and r.expires_at <= now();

  if exists (
    select 1 from public.content_publish_requests r
    where r.post_id = v_post.id and r.destination_id = v_destination.id and r.status = 'pending'
  ) then
    raise exception 'A publish request is already pending for this post and destination' using errcode = 'CP412';
  end if;

  insert into public.content_publish_requests (
    workspace_id, post_id, post_version, request_source, agent_turn_id, reason, expires_at, destination_id
  ) values (
    v_post.workspace_id, v_post.id, v_post.version, p_source, p_agent_turn_id, v_reason,
    now() + interval '7 days', v_destination.id
  )
  returning * into v_request;

  return v_request;
end;
$$;

drop function public.approve_publish_request(uuid, integer);

-- Approves a pending request for exactly its destination, post and version.
-- Internal destination: publishes the post and records a succeeded delivery, in
-- one transaction. Any other destination (M5): records a queued delivery only.
create function public.approve_publish_request(
  p_request_id uuid,
  p_expected_post_version integer,
  p_expected_destination_id uuid default null
)
returns public.content_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.content_publish_requests;
  v_destination public.publishing_destinations;
  v_post public.content_posts;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_request_id is null or p_expected_post_version is null then
    raise exception 'request id and expected post version are required' using errcode = '22023';
  end if;
  if public.publish_caller_is_agent() then
    raise exception 'The AI agent cannot approve publish requests' using errcode = '42501';
  end if;

  select * into v_request from public.content_publish_requests r where r.id = p_request_id;
  if not found or not public.is_workspace_member(v_request.workspace_id) then
    raise exception 'Publish request not found' using errcode = 'CP404';
  end if;
  if not public.has_workspace_role(v_request.workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can approve publish requests' using errcode = '42501';
  end if;
  if v_request.status <> 'pending' or v_request.expires_at <= now() then
    raise exception 'Publish request is no longer pending' using errcode = 'CP410';
  end if;
  if p_expected_post_version <> v_request.post_version
     or (p_expected_destination_id is not null and p_expected_destination_id <> v_request.destination_id) then
    raise exception 'Publish request does not match what was reviewed' using errcode = 'CP409';
  end if;

  -- Lock order post -> request, as in M4.1 (edits cancel pending requests).
  v_post := public.lock_content_post_for_write(v_request.post_id, v_request.post_version);

  select * into v_request from public.content_publish_requests r where r.id = p_request_id for update;
  if v_request.status <> 'pending' or v_request.expires_at <= now() then
    raise exception 'Publish request is no longer pending' using errcode = 'CP410';
  end if;
  if v_request.requested_at >= now() then
    raise exception 'Approval must be a separate action' using errcode = '42501';
  end if;

  select * into v_destination from public.publishing_destinations d
   where d.id = v_request.destination_id and d.workspace_id = v_request.workspace_id;
  if not found then
    raise exception 'Publishing destination not found' using errcode = 'CP404';
  end if;
  if v_destination.status <> 'active' then
    raise exception 'Publishing destination is disabled' using errcode = 'CP426';
  end if;

  if v_post.archived_at is not null
     or exists (
       select 1 from public.content_projects pr
       where pr.id = v_post.project_id and pr.archived_at is not null
     ) then
    raise exception 'Content post is archived' using errcode = 'CP423';
  end if;
  if v_post.status = 'published' then
    raise exception 'Content post is already published' using errcode = 'CP422';
  end if;

  update public.content_publish_requests r
     set status = 'approved'
   where r.id = v_request.id;

  if v_destination.kind = 'internal' then
    update public.content_posts p
       set status = 'published',
           last_change_source = 'user'
     where p.id = v_post.id
       and p.version = v_request.post_version
    returning * into v_post;
    if not found then
      raise exception 'Content post was changed by someone else' using errcode = 'CP409';
    end if;

    insert into public.publish_deliveries (
      workspace_id, request_id, destination_id, post_id, post_version, status, attempt_count,
      idempotency_key, completed_at
    ) values (
      v_request.workspace_id, v_request.id, v_destination.id, v_request.post_id, v_request.post_version,
      'succeeded', 1, 'request:' || v_request.id::text, now()
    );

    insert into public.content_publish_request_events (
      workspace_id, request_id, post_id, post_version, event, actor_id, actor_source
    ) values (
      v_post.workspace_id, v_request.id, v_post.id, v_post.version, 'published', (select auth.uid()), 'user'
    );
  else
    -- External destinations (M5): approval only queues the delivery; a worker
    -- publishes it later through the destination's Publisher Adapter.
    insert into public.publish_deliveries (
      workspace_id, request_id, destination_id, post_id, post_version, status, idempotency_key, next_attempt_at
    ) values (
      v_request.workspace_id, v_request.id, v_destination.id, v_request.post_id, v_request.post_version,
      'queued', 'request:' || v_request.id::text, now()
    );
  end if;

  return v_post;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

revoke all on function public.publishing_destinations_before_write() from public, anon, authenticated;
revoke all on function public.create_internal_publishing_destination() from public, anon, authenticated;
revoke all on function public.publish_deliveries_guard() from public, anon, authenticated;

revoke all on function public.request_post_publish(uuid, integer, public.content_change_source, uuid, text, uuid) from public, anon;
revoke all on function public.approve_publish_request(uuid, integer, uuid) from public, anon;
grant execute on function public.request_post_publish(uuid, integer, public.content_change_source, uuid, text, uuid) to authenticated;
grant execute on function public.approve_publish_request(uuid, integer, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges and RLS
-- ---------------------------------------------------------------------------

revoke all on table public.publishing_destinations from public, anon, authenticated;
revoke all on table public.publish_deliveries from public, anon, authenticated;

-- Members read their workspace's destinations; owners/admins manage them (RLS).
-- Today the only kind is internal and it already exists, so no insert can succeed.
grant select on table public.publishing_destinations to authenticated;
grant insert (workspace_id, kind, name, target_ref) on table public.publishing_destinations to authenticated;
grant update (name, status, target_ref) on table public.publishing_destinations to authenticated;
-- No DELETE: a destination referenced by requests must stay for the audit trail.

-- Deliveries are written only by approve_publish_request (and, in M5, by a
-- server-side worker function). Clients may only read them.
grant select on table public.publish_deliveries to authenticated;

alter table public.publishing_destinations enable row level security;
alter table public.publish_deliveries enable row level security;

create policy "Members can view the publishing destinations of their workspace"
on public.publishing_destinations for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "Owners and admins can add publishing destinations"
on public.publishing_destinations for insert
to authenticated
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "Owners and admins can update publishing destinations"
on public.publishing_destinations for update
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "Members can view the publish deliveries of their workspace"
on public.publish_deliveries for select
to authenticated
using (public.is_workspace_member(workspace_id));
