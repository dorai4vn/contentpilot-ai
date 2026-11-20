-- ContentPilot AI — M4.1: human approval for publishing (database foundation).
--
-- Publishing a post now requires an explicit human decision:
--   1. A member (or the AI agent acting for a member) creates a publish request
--      for one exact version of a post:        request_post_publish()
--   2. An owner/admin of the workspace approves it in a separate call:
--                                               approve_publish_request()
--      The approval and the status change to 'published' happen in the same
--      transaction. Owners/admins may approve their own requests, but always
--      with this separate, explicit call (never automatically).
--   3. Or the request is rejected (owner/admin) or cancelled (requester or
--      owner/admin):  reject_publish_request() / cancel_publish_request()
--
-- Security model
--   * Publishing is enforced by a trigger on content_posts, not by the UI or the
--     RPCs alone. The M2 CHECK "publishing disabled" is replaced by:
--       - INSERT with status 'published' is always rejected (authenticated holds
--         INSERT on the status column, so without this a client could create a
--         published post directly through the API).
--       - UPDATE to 'published' passes only if a request for exactly this post and
--         version was approved in the SAME transaction by the current user
--         (decided_at = now(), decided_by = auth.uid()). Only
--         approve_publish_request() can produce that, so no other path (old RPCs,
--         other SECURITY DEFINER code, a superuser UPDATE) can publish.
--       - The publishing UPDATE may change nothing but the status; published_at is
--         set by the database.
--       - A published post is read-only in M4 (CP422).
--   * Requests and their audit events are written only by the RPCs/triggers in
--     this file. authenticated may only SELECT them (RLS: workspace members).
--     Nothing is granted to anon.
--   * Who did what comes from auth.uid() and now() inside the database; no
--     function takes a user id or a timestamp as a parameter.
--   * Only owners/admins of the request's workspace (taken from the stored row)
--     can approve or reject. The AI agent cannot approve: it has no tool for it,
--     and as defence in depth the approve/reject RPCs refuse calls that carry the
--     agent marker header (x-contentpilot-actor: agent).
--   * Replay / staleness: a decision is final (pending -> approved/rejected/
--     cancelled exactly once, enforced by trigger); approval requires the post
--     version the approver saw, the post to still be at the requested version
--     (row lock + optimistic locking) and the request not to be expired
--     (7 days). Any change to the post cancels its pending request.
--   * Workspace isolation: composite foreign keys keep requests and events in the
--     workspace of their post; access checks use the stored workspace.
--
-- Error codes (in addition to CP404 / CP409 / CP423 from M2):
--   CP410  the request is no longer pending (already decided, cancelled) or expired
--   CP412  the post already has a pending publish request
--   CP422  the post is published and therefore read-only
--   42501  not allowed (role, agent marker, publishing without approval)
--
-- SECURITY DEFINER functions in this file (search_path = '', schema-qualified
-- names, no caller-supplied user id, EXECUTE revoked from public/anon):
--   * request_post_publish / approve_publish_request / reject_publish_request /
--     cancel_publish_request: RPCs for authenticated, with explicit checks.
--   * publish_request_record_event(), content_posts_cancel_stale_publish_requests():
--     trigger functions; EXECUTE revoked from everyone.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.publish_request_status as enum ('pending', 'approved', 'rejected', 'cancelled');
create type public.publish_request_cancel_reason as enum ('withdrawn', 'post_changed', 'expired');
create type public.publish_request_event as enum ('requested', 'approved', 'rejected', 'cancelled', 'published');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.content_publish_requests (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  post_id         uuid not null,
  post_version    integer not null check (post_version >= 1),
  status          public.publish_request_status not null default 'pending',
  request_source  public.content_change_source not null,
  agent_turn_id   uuid,
  reason          text check (reason is null or char_length(reason) between 1 and 500),
  requested_by    uuid references auth.users (id) on delete set null,
  requested_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  decided_by      uuid references auth.users (id) on delete set null,
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or char_length(decision_note) between 1 and 500),
  cancel_reason   public.publish_request_cancel_reason,
  constraint content_publish_requests_post_fkey foreign key (workspace_id, post_id)
    references public.content_posts (workspace_id, id) on delete restrict,
  constraint content_publish_requests_workspace_id_id_key unique (workspace_id, id),
  constraint content_publish_requests_expiry check (expires_at = requested_at + interval '7 days'),
  constraint content_publish_requests_agent_turn check ((request_source = 'agent') = (agent_turn_id is not null)),
  constraint content_publish_requests_pending_undecided check (
    status <> 'pending' or (decided_by is null and decided_at is null and decision_note is null and cancel_reason is null)
  ),
  constraint content_publish_requests_decided check (status = 'pending' or decided_at is not null),
  -- A decision is always a separate, later action than the request.
  constraint content_publish_requests_decided_after_request check (decided_at is null or decided_at > requested_at),
  constraint content_publish_requests_cancel_reason check ((status = 'cancelled') = (cancel_reason is not null)),
  constraint content_publish_requests_note_only_for_rejection check (decision_note is null or status = 'rejected')
);

comment on table public.content_publish_requests is
  'Requests to publish one exact version of a post. Decided once by an owner/admin; written only by RPCs.';

-- At most one pending request per post.
create unique index content_publish_requests_one_pending
  on public.content_publish_requests (post_id) where status = 'pending';
create index content_publish_requests_workspace_status_idx
  on public.content_publish_requests (workspace_id, status, requested_at desc);
-- At most one approval per post version.
create unique index content_publish_requests_one_approval_per_version
  on public.content_publish_requests (post_id, post_version) where status = 'approved';

create table public.content_publish_request_events (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  request_id    uuid not null,
  post_id       uuid not null,
  post_version  integer not null,
  event         public.publish_request_event not null,
  cancel_reason public.publish_request_cancel_reason,
  actor_id      uuid references auth.users (id) on delete set null,
  actor_source  public.content_change_source,
  created_at    timestamptz not null default now(),
  constraint content_publish_request_events_request_fkey foreign key (workspace_id, request_id)
    references public.content_publish_requests (workspace_id, id) on delete restrict,
  constraint content_publish_request_events_post_fkey foreign key (workspace_id, post_id)
    references public.content_posts (workspace_id, id) on delete restrict,
  constraint content_publish_request_events_cancel_reason check ((event = 'cancelled') = (cancel_reason is not null))
);

comment on table public.content_publish_request_events is
  'Append-only audit trail of publish requests (requested, approved, rejected, cancelled, published).';

create index content_publish_request_events_request_idx
  on public.content_publish_request_events (request_id, created_at);
create index content_publish_request_events_workspace_idx
  on public.content_publish_request_events (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Publishing guard on content_posts (replaces the M2 "publishing disabled" CHECKs)
-- ---------------------------------------------------------------------------

alter table public.content_posts drop constraint content_posts_publishing_disabled;
alter table public.content_post_versions drop constraint content_post_versions_publishing_disabled;

-- A published post always has a publication time, and only a published post has one.
alter table public.content_posts add constraint content_posts_published_at_consistency
  check ((status = 'published') = (published_at is not null));

comment on table public.content_posts is
  'Content posts. Updated only through RPCs with expected_version; published only through an approved publish request.';

-- Runs after content_posts_before_insert / content_posts_before_update (triggers
-- fire in name order), so it sees the final row including the new version.
create function public.content_posts_guard_publish()
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

  -- Published posts are read-only (only bookkeeping such as clearing user ids on
  -- account deletion is allowed).
  if old.status = 'published' then
    if (new.title, new.body, new.status, new.scheduled_for, new.archived_at, new.published_at, new.last_change_source)
       is distinct from
       (old.title, old.body, old.status, old.scheduled_for, old.archived_at, old.published_at, old.last_change_source) then
      raise exception 'Published posts cannot be changed' using errcode = 'CP422';
    end if;
    return new;
  end if;

  if new.status = 'published' then
    -- Publishing may change nothing but the status: the approved version is what goes live.
    if (new.title, new.body, new.scheduled_for, new.archived_at)
       is distinct from (old.title, old.body, old.scheduled_for, old.archived_at)
       or old.archived_at is not null then
      raise exception 'Publishing requires an approved publish request' using errcode = '42501';
    end if;
    if (select auth.uid()) is null or not exists (
      select 1
      from public.content_publish_requests r
      where r.post_id = new.id
        and r.workspace_id = new.workspace_id
        and r.post_version = old.version
        and r.status = 'approved'
        and r.decided_by = (select auth.uid())
        and r.decided_at = now()  -- approved in this very transaction
    ) then
      raise exception 'Publishing requires an approved publish request' using errcode = '42501';
    end if;
    new.published_at := now();
  end if;

  return new;
end;
$$;

create trigger content_posts_guard_publish
before insert or update on public.content_posts
for each row execute function public.content_posts_guard_publish();

-- ---------------------------------------------------------------------------
-- Triggers: content_publish_requests
-- ---------------------------------------------------------------------------

-- Server-side values for a new request: requester, time, expiry, pending state.
create function public.content_publish_requests_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.requested_by := (select auth.uid());
  if new.requested_by is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  new.requested_at := now();
  new.expires_at := new.requested_at + interval '7 days';
  new.status := 'pending';
  new.decided_by := null;
  new.decided_at := null;
  new.decision_note := null;
  new.cancel_reason := null;
  return new;
end;
$$;

create trigger content_publish_requests_before_insert
before insert on public.content_publish_requests
for each row execute function public.content_publish_requests_before_insert();

-- A request is decided exactly once (pending -> approved/rejected/cancelled).
-- The deciding user and time come from the database. No DELETE, even for the owner.
-- The only other change allowed is clearing user ids when an account is deleted.
create function public.content_publish_requests_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Publish requests cannot be deleted' using errcode = '42501';
  end if;

  if (new.id, new.workspace_id, new.post_id, new.post_version, new.request_source, new.agent_turn_id,
      new.reason, new.requested_at, new.expires_at)
     is distinct from
     (old.id, old.workspace_id, old.post_id, old.post_version, old.request_source, old.agent_turn_id,
      old.reason, old.requested_at, old.expires_at)
     or (new.requested_by is distinct from old.requested_by and new.requested_by is not null) then
    raise exception 'Publish request identity cannot be changed' using errcode = '42501';
  end if;

  if new.status = old.status then
    -- Bookkeeping only: ON DELETE SET NULL of requested_by / decided_by.
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

create trigger content_publish_requests_guard_update
before update or delete on public.content_publish_requests
for each row execute function public.content_publish_requests_guard_update();

-- Audit trail: one event per request creation and per decision.
-- SECURITY DEFINER: authenticated cannot write events itself.
create function public.publish_request_record_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.content_change_source;
begin
  if tg_op = 'INSERT' then
    v_source := new.request_source;
  elsif new.status is not distinct from old.status then
    return null;
  elsif new.cancel_reason = 'post_changed' then
    select p.last_change_source into v_source from public.content_posts p where p.id = new.post_id;
  else
    v_source := 'user';
  end if;

  insert into public.content_publish_request_events (
    workspace_id, request_id, post_id, post_version, event, cancel_reason, actor_id, actor_source
  ) values (
    new.workspace_id, new.id, new.post_id, new.post_version,
    case when tg_op = 'INSERT' then 'requested' else new.status::text end::public.publish_request_event,
    new.cancel_reason,
    case when tg_op = 'INSERT' then new.requested_by else new.decided_by end,
    v_source
  );
  return null;
end;
$$;

create trigger content_publish_requests_record_event
after insert or update on public.content_publish_requests
for each row execute function public.publish_request_record_event();

-- Events are append-only (except clearing actor_id on account deletion).
create function public.content_publish_request_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.actor_id is null
     and (new.id, new.workspace_id, new.request_id, new.post_id, new.post_version, new.event,
          new.cancel_reason, new.actor_source, new.created_at)
         is not distinct from
         (old.id, old.workspace_id, old.request_id, old.post_id, old.post_version, old.event,
          old.cancel_reason, old.actor_source, old.created_at) then
    return new;
  end if;
  raise exception 'Publish request audit trail is append-only' using errcode = '42501';
end;
$$;

create trigger content_publish_request_events_append_only
before update or delete on public.content_publish_request_events
for each row execute function public.content_publish_request_events_append_only();

-- Any change to a post (new version) cancels its pending request, so an approver
-- never approves content other than what was requested. Publishing itself is
-- excluded (the request is already approved at that point).
-- SECURITY DEFINER: the editor has no UPDATE privilege on publish requests.
create function public.content_posts_cancel_stale_publish_requests()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.content_publish_requests r
     set status = 'cancelled',
         cancel_reason = 'post_changed'
   where r.post_id = new.id
     and r.status = 'pending';
  return null;
end;
$$;

create trigger content_posts_cancel_stale_publish_requests
after update on public.content_posts
for each row
when (new.version is distinct from old.version and new.status is distinct from 'published')
execute function public.content_posts_cancel_stale_publish_requests();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- True when the API request carries the AI agent marker header. The agent's
-- server code always sends it; a human-driven request does not. Defence in depth
-- against programming mistakes (the agent has no approval tool at all).
-- Malformed header JSON raises an error, so the check fails closed.
create function public.publish_caller_is_agent()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (nullif(current_setting('request.headers', true), '')::json ->> 'x-contentpilot-actor') = 'agent',
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Creates a pending request to publish the post at exactly p_expected_version.
create function public.request_post_publish(
  p_post_id uuid,
  p_expected_version integer,
  p_source public.content_change_source default 'user',
  p_agent_turn_id uuid default null,
  p_reason text default null
)
returns public.content_publish_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.content_posts;
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
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'reason is too long' using errcode = '22023';
  end if;

  -- Authentication, membership (CP404), row lock and expected version (CP409).
  v_post := public.lock_content_post_for_write(p_post_id, p_expected_version);

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

  -- An expired pending request no longer blocks a new one.
  update public.content_publish_requests r
     set status = 'cancelled', cancel_reason = 'expired'
   where r.post_id = v_post.id and r.status = 'pending' and r.expires_at <= now();

  if exists (
    select 1 from public.content_publish_requests r
    where r.post_id = v_post.id and r.status = 'pending'
  ) then
    raise exception 'A publish request is already pending for this post' using errcode = 'CP412';
  end if;

  insert into public.content_publish_requests (
    workspace_id, post_id, post_version, request_source, agent_turn_id, reason, expires_at
  ) values (
    v_post.workspace_id, v_post.id, v_post.version, p_source, p_agent_turn_id, v_reason,
    now() + interval '7 days'
  )
  returning * into v_request;

  return v_request;
end;
$$;

-- Approves a pending request and publishes the post, in one transaction.
-- p_expected_post_version is the version the approver was shown.
create function public.approve_publish_request(
  p_request_id uuid,
  p_expected_post_version integer
)
returns public.content_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.content_publish_requests;
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
  if p_expected_post_version <> v_request.post_version then
    raise exception 'Content post was changed by someone else' using errcode = 'CP409';
  end if;

  -- Lock order post -> request (same as edits, which cancel pending requests),
  -- so concurrent approve/edit cannot deadlock. CP409 if the post changed.
  v_post := public.lock_content_post_for_write(v_request.post_id, v_request.post_version);

  select * into v_request from public.content_publish_requests r where r.id = p_request_id for update;
  if v_request.status <> 'pending' or v_request.expires_at <= now() then
    raise exception 'Publish request is no longer pending' using errcode = 'CP410';
  end if;
  if v_request.requested_at >= now() then
    raise exception 'Approval must be a separate action' using errcode = '42501';
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

  update public.content_posts p
     set status = 'published',
         last_change_source = 'user'
   where p.id = v_post.id
     and p.version = v_request.post_version
  returning * into v_post;
  if not found then
    raise exception 'Content post was changed by someone else' using errcode = 'CP409';
  end if;

  insert into public.content_publish_request_events (
    workspace_id, request_id, post_id, post_version, event, actor_id, actor_source
  ) values (
    v_post.workspace_id, v_request.id, v_post.id, v_post.version, 'published', (select auth.uid()), 'user'
  );

  return v_post;
end;
$$;

create function public.reject_publish_request(
  p_request_id uuid,
  p_note text default null
)
returns public.content_publish_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.content_publish_requests;
  v_note text := nullif(btrim(p_note), '');
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request id is required' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note is too long' using errcode = '22023';
  end if;
  if public.publish_caller_is_agent() then
    raise exception 'The AI agent cannot reject publish requests' using errcode = '42501';
  end if;

  select * into v_request from public.content_publish_requests r where r.id = p_request_id;
  if not found or not public.is_workspace_member(v_request.workspace_id) then
    raise exception 'Publish request not found' using errcode = 'CP404';
  end if;
  if not public.has_workspace_role(v_request.workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can reject publish requests' using errcode = '42501';
  end if;

  select * into v_request from public.content_publish_requests r where r.id = p_request_id for update;
  if v_request.status <> 'pending' or v_request.expires_at <= now() then
    raise exception 'Publish request is no longer pending' using errcode = 'CP410';
  end if;
  if v_request.requested_at >= now() then
    raise exception 'Rejection must be a separate action' using errcode = '42501';
  end if;

  update public.content_publish_requests r
     set status = 'rejected', decision_note = v_note
   where r.id = v_request.id
  returning * into v_request;
  return v_request;
end;
$$;

-- Withdraws a pending request (the requester or an owner/admin). Also the way to
-- close an expired request (recorded with cancel_reason 'expired').
create function public.cancel_publish_request(p_request_id uuid)
returns public.content_publish_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.content_publish_requests;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request id is required' using errcode = '22023';
  end if;

  select * into v_request from public.content_publish_requests r where r.id = p_request_id;
  if not found or not public.is_workspace_member(v_request.workspace_id) then
    raise exception 'Publish request not found' using errcode = 'CP404';
  end if;
  if v_request.requested_by is distinct from (select auth.uid())
     and not public.has_workspace_role(v_request.workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only the requester or an owner/admin can cancel this request' using errcode = '42501';
  end if;

  select * into v_request from public.content_publish_requests r where r.id = p_request_id for update;
  if v_request.status <> 'pending' then
    raise exception 'Publish request is no longer pending' using errcode = 'CP410';
  end if;

  update public.content_publish_requests r
     set status = 'cancelled',
         cancel_reason = case when r.expires_at <= now() then 'expired' else 'withdrawn' end::public.publish_request_cancel_reason
   where r.id = v_request.id
  returning * into v_request;
  return v_request;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

revoke all on function public.content_posts_guard_publish() from public, anon, authenticated;
revoke all on function public.content_publish_requests_before_insert() from public, anon, authenticated;
revoke all on function public.content_publish_requests_guard_update() from public, anon, authenticated;
revoke all on function public.publish_request_record_event() from public, anon, authenticated;
revoke all on function public.content_publish_request_events_append_only() from public, anon, authenticated;
revoke all on function public.content_posts_cancel_stale_publish_requests() from public, anon, authenticated;
revoke all on function public.publish_caller_is_agent() from public, anon, authenticated;

revoke all on function public.request_post_publish(uuid, integer, public.content_change_source, uuid, text) from public, anon;
revoke all on function public.approve_publish_request(uuid, integer) from public, anon;
revoke all on function public.reject_publish_request(uuid, text) from public, anon;
revoke all on function public.cancel_publish_request(uuid) from public, anon;
grant execute on function public.request_post_publish(uuid, integer, public.content_change_source, uuid, text) to authenticated;
grant execute on function public.approve_publish_request(uuid, integer) to authenticated;
grant execute on function public.reject_publish_request(uuid, text) to authenticated;
grant execute on function public.cancel_publish_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges (explicit: Supabase grants ALL on new tables by default)
-- ---------------------------------------------------------------------------

revoke all on table public.content_publish_requests from public, anon, authenticated;
revoke all on table public.content_publish_request_events from public, anon, authenticated;
grant select on table public.content_publish_requests to authenticated;
grant select on table public.content_publish_request_events to authenticated;
-- No INSERT / UPDATE / DELETE: requests change only through the RPCs above,
-- events are written only by triggers and approve_publish_request().

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.content_publish_requests enable row level security;
alter table public.content_publish_request_events enable row level security;

create policy "Members can view publish requests of their workspace"
on public.content_publish_requests for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "Members can view the publish audit trail of their workspace"
on public.content_publish_request_events for select
to authenticated
using (public.is_workspace_member(workspace_id));
