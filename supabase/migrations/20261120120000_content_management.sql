-- ContentPilot AI — M2: content projects, posts and version history.
--
-- Security model (builds on the M1 helpers is_workspace_member / has_workspace_role)
--   * Every row belongs to a workspace. RLS is enabled on every table; nothing is
--     granted to `anon`. Reads require membership of the row's workspace.
--   * Projects: owners/admins create, rename and archive them. Members only read.
--   * Posts: any member creates them (INSERT, column-restricted). There is NO
--     UPDATE or DELETE privilege on content_posts: every change goes through the
--     RPCs below, which require the caller's expected_version (optimistic locking).
--   * History: content_post_versions is append-only and written only by a trigger,
--     in the same transaction as the change it records.
--   * Publishing is disabled in M2: a CHECK constraint rejects status 'published'
--     for every writer, including SECURITY DEFINER code. M4 will lift it in a new
--     migration together with the human-approval workflow.
--   * Permanent deletion is disabled in M2: no DELETE privilege or policy on any
--     content table, foreign keys use ON DELETE RESTRICT (a workspace that still
--     has content cannot be deleted), and history rows reject UPDATE/DELETE.
--
-- SECURITY DEFINER functions in this file (all: search_path = '', schema-qualified
-- names, no caller-supplied user id, EXECUTE revoked from public/anon):
--   * record_content_post_version()   trigger only; EXECUTE revoked from everyone.
--   * lock_content_post_for_write()    internal; EXECUTE revoked from everyone.
--   * update_content_post / archive_content_post / restore_content_post
--       RPCs for `authenticated`. They bypass RLS (content_posts has no UPDATE
--       grant), so they re-implement the access checks explicitly: auth.uid() must
--       be set, the caller must be a member of the post's workspace (taken from the
--       stored row, never from a parameter), the row is locked FOR UPDATE and its
--       version must equal p_expected_version.
--
-- Error codes raised for the application layer (src/lib must map them to generic
-- messages): CP404 not found / no access, CP409 version conflict, CP423 archived.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.content_post_status as enum ('draft', 'ready', 'published');
create type public.content_change_source as enum ('user', 'agent');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.content_projects (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete restrict,
  name          text not null check (char_length(btrim(name)) between 1 and 100),
  description   text check (description is null or char_length(description) <= 1000),
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint content_projects_workspace_id_id_key unique (workspace_id, id)
);

comment on table public.content_projects is 'Content projects inside a workspace. Archived, never deleted, in M2.';

create table public.content_posts (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null,
  project_id          uuid not null,
  title               text not null check (char_length(btrim(title)) between 1 and 200),
  body                text not null default '' check (char_length(body) <= 50000),
  status              public.content_post_status not null default 'draft',
  scheduled_for       timestamptz,
  published_at        timestamptz,
  version             integer not null default 1 check (version >= 1),
  last_change_source  public.content_change_source not null default 'user',
  created_by          uuid references auth.users (id) on delete set null,
  updated_by          uuid references auth.users (id) on delete set null,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- A post always lives in a project of the same workspace.
  constraint content_posts_project_fkey foreign key (workspace_id, project_id)
    references public.content_projects (workspace_id, id) on delete restrict,
  constraint content_posts_workspace_id_id_key unique (workspace_id, id),
  -- M2: publishing is disabled for every writer. Lifted only in M4.
  constraint content_posts_publishing_disabled
    check (status <> 'published' and published_at is null)
);

comment on table public.content_posts is
  'Content posts. Updated only through RPCs with expected_version; publishing disabled in M2.';
comment on column public.content_posts.scheduled_for is 'Planned publication time (UTC). Informational in M2.';
comment on column public.content_posts.version is 'Optimistic-locking counter, incremented by trigger on every change.';

create index content_posts_project_status_idx on public.content_posts (workspace_id, project_id, status);
create index content_posts_scheduled_for_idx on public.content_posts (workspace_id, scheduled_for)
  where scheduled_for is not null;

create table public.content_post_versions (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  post_id        uuid not null,
  version        integer not null check (version >= 1),
  title          text not null,
  body           text not null,
  status         public.content_post_status not null,
  scheduled_for  timestamptz,
  archived_at    timestamptz,
  changed_by     uuid references auth.users (id) on delete set null,
  change_source  public.content_change_source not null,
  created_at     timestamptz not null default now(),
  constraint content_post_versions_post_fkey foreign key (workspace_id, post_id)
    references public.content_posts (workspace_id, id) on delete restrict,
  constraint content_post_versions_post_version_key unique (post_id, version),
  constraint content_post_versions_publishing_disabled check (status <> 'published')
);

comment on table public.content_post_versions is 'Append-only snapshot of every version of a post.';

-- ---------------------------------------------------------------------------
-- Triggers: content_projects
-- ---------------------------------------------------------------------------

create function public.content_projects_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := (select auth.uid());
  if new.created_by is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  new.archived_at := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger content_projects_before_insert
before insert on public.content_projects
for each row execute function public.content_projects_before_insert();

-- Identity columns are immutable (created_by may only be cleared by ON DELETE SET NULL).
create function public.content_projects_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.workspace_id is distinct from old.workspace_id
     or new.created_at is distinct from old.created_at
     or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    raise exception 'Project identity cannot be changed' using errcode = '42501';
  end if;

  -- archived_at is a server timestamp: archiving stamps now(), re-archiving keeps it.
  if new.archived_at is not null then
    new.archived_at := coalesce(old.archived_at, now());
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger content_projects_before_update
before update on public.content_projects
for each row execute function public.content_projects_before_update();

-- ---------------------------------------------------------------------------
-- Triggers: content_posts
-- ---------------------------------------------------------------------------

create function public.content_posts_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := (select auth.uid());
  if new.created_by is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  new.updated_by := new.created_by;
  new.version := 1;
  new.archived_at := null;
  new.published_at := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger content_posts_before_insert
before insert on public.content_posts
for each row execute function public.content_posts_before_insert();

-- Every content change bumps the version by exactly one. Changes that touch only
-- created_by/updated_by (ON DELETE SET NULL of a deleted account) are bookkeeping:
-- they keep the version and create no history row.
create function public.content_posts_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.workspace_id is distinct from old.workspace_id
     or new.project_id is distinct from old.project_id
     or new.created_at is distinct from old.created_at
     or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    raise exception 'Post identity cannot be changed' using errcode = '42501';
  end if;

  if (new.title, new.body, new.status, new.scheduled_for, new.archived_at, new.last_change_source)
     is not distinct from
     (old.title, old.body, old.status, old.scheduled_for, old.archived_at, old.last_change_source) then
    if new.updated_by is distinct from old.updated_by and new.updated_by is not null then
      raise exception 'updated_by is managed by the database' using errcode = '42501';
    end if;
    new.version := old.version;
    new.updated_at := old.updated_at;
    return new;
  end if;

  new.version := old.version + 1;
  new.updated_by := (select auth.uid());
  new.updated_at := now();
  return new;
end;
$$;

create trigger content_posts_before_update
before update on public.content_posts
for each row execute function public.content_posts_before_update();

-- SECURITY DEFINER: authenticated has no INSERT on content_post_versions, so the
-- snapshot is written with the owner's rights. It copies only NEW, which already
-- passed RLS / the RPC checks and all constraints.
create function public.record_content_post_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.content_post_versions (
    workspace_id, post_id, version, title, body, status, scheduled_for, archived_at,
    changed_by, change_source
  ) values (
    new.workspace_id, new.id, new.version, new.title, new.body, new.status, new.scheduled_for,
    new.archived_at, new.updated_by, new.last_change_source
  );
  return null;
end;
$$;

create trigger content_posts_record_version_on_insert
after insert on public.content_posts
for each row execute function public.record_content_post_version();

create trigger content_posts_record_version_on_update
after update on public.content_posts
for each row
when (new.version is distinct from old.version)
execute function public.record_content_post_version();

-- ---------------------------------------------------------------------------
-- Triggers: content_post_versions (append-only)
-- ---------------------------------------------------------------------------

-- Rejects every UPDATE/DELETE, even from the table owner, except clearing
-- changed_by when the account is deleted (ON DELETE SET NULL).
create function public.content_post_versions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.changed_by is null
     and (new.id, new.workspace_id, new.post_id, new.version, new.title, new.body, new.status,
          new.scheduled_for, new.archived_at, new.change_source, new.created_at)
         is not distinct from
         (old.id, old.workspace_id, old.post_id, old.version, old.title, old.body, old.status,
          old.scheduled_for, old.archived_at, old.change_source, old.created_at) then
    return new;
  end if;
  raise exception 'Version history is append-only' using errcode = '42501';
end;
$$;

create trigger content_post_versions_append_only
before update or delete on public.content_post_versions
for each row execute function public.content_post_versions_append_only();

-- ---------------------------------------------------------------------------
-- RPCs (the only way to change a post)
-- ---------------------------------------------------------------------------

-- Internal: authenticates the caller, checks workspace membership, locks the row
-- and enforces the expected version. SECURITY DEFINER so it can read and lock
-- posts regardless of the caller's privileges; not callable by any API role.
create function public.lock_content_post_for_write(p_post_id uuid, p_expected_version integer)
returns public.content_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_post public.content_posts;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_post_id is null or p_expected_version is null then
    raise exception 'post id and expected version are required' using errcode = '22023';
  end if;

  -- Membership is checked before locking, so non-members cannot even hold a lock.
  select p.workspace_id into v_workspace_id from public.content_posts p where p.id = p_post_id;
  if v_workspace_id is null or not public.is_workspace_member(v_workspace_id) then
    raise exception 'Content post not found' using errcode = 'CP404';
  end if;

  select * into v_post from public.content_posts p where p.id = p_post_id for update;

  if v_post.version <> p_expected_version then
    raise exception 'Content post was changed by someone else' using errcode = 'CP409';
  end if;

  return v_post;
end;
$$;

-- Replaces the editable fields of a post with the caller's full new state.
create function public.update_content_post(
  p_post_id uuid,
  p_expected_version integer,
  p_title text,
  p_body text,
  p_status public.content_post_status,
  p_scheduled_for timestamptz,
  p_change_source public.content_change_source default 'user'
)
returns public.content_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.content_posts;
begin
  v_post := public.lock_content_post_for_write(p_post_id, p_expected_version);

  if v_post.archived_at is not null
     or exists (
       select 1 from public.content_projects pr
       where pr.id = v_post.project_id and pr.archived_at is not null
     ) then
    raise exception 'Content post is archived' using errcode = 'CP423';
  end if;
  if p_status is null or p_change_source is null then
    raise exception 'status and change source are required' using errcode = '22023';
  end if;
  if p_status = 'published' then
    raise exception 'Publishing is not available' using errcode = '42501';
  end if;

  -- Unchanged content: no new version.
  if (v_post.title, v_post.body, v_post.status, v_post.scheduled_for)
     is not distinct from (p_title, p_body, p_status, p_scheduled_for) then
    return v_post;
  end if;

  update public.content_posts
     set title = p_title,
         body = p_body,
         status = p_status,
         scheduled_for = p_scheduled_for,
         last_change_source = p_change_source
   where id = p_post_id
     and version = p_expected_version
  returning * into v_post;

  if not found then
    raise exception 'Content post was changed by someone else' using errcode = 'CP409';
  end if;
  return v_post;
end;
$$;

create function public.archive_content_post(
  p_post_id uuid,
  p_expected_version integer,
  p_change_source public.content_change_source default 'user'
)
returns public.content_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.content_posts;
begin
  v_post := public.lock_content_post_for_write(p_post_id, p_expected_version);
  if p_change_source is null then
    raise exception 'change source is required' using errcode = '22023';
  end if;
  if v_post.archived_at is not null then
    return v_post;
  end if;

  update public.content_posts
     set archived_at = now(),
         last_change_source = p_change_source
   where id = p_post_id
     and version = p_expected_version
  returning * into v_post;

  if not found then
    raise exception 'Content post was changed by someone else' using errcode = 'CP409';
  end if;
  return v_post;
end;
$$;

create function public.restore_content_post(
  p_post_id uuid,
  p_expected_version integer,
  p_change_source public.content_change_source default 'user'
)
returns public.content_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.content_posts;
begin
  v_post := public.lock_content_post_for_write(p_post_id, p_expected_version);
  if p_change_source is null then
    raise exception 'change source is required' using errcode = '22023';
  end if;
  if v_post.archived_at is null then
    return v_post;
  end if;
  if exists (
    select 1 from public.content_projects pr
    where pr.id = v_post.project_id and pr.archived_at is not null
  ) then
    raise exception 'Project is archived' using errcode = 'CP423';
  end if;

  update public.content_posts
     set archived_at = null,
         last_change_source = p_change_source
   where id = p_post_id
     and version = p_expected_version
  returning * into v_post;

  if not found then
    raise exception 'Content post was changed by someone else' using errcode = 'CP409';
  end if;
  return v_post;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

-- Trigger and internal functions: nobody may call them directly.
revoke all on function public.content_projects_before_insert() from public, anon, authenticated;
revoke all on function public.content_projects_before_update() from public, anon, authenticated;
revoke all on function public.content_posts_before_insert() from public, anon, authenticated;
revoke all on function public.content_posts_before_update() from public, anon, authenticated;
revoke all on function public.record_content_post_version() from public, anon, authenticated;
revoke all on function public.content_post_versions_append_only() from public, anon, authenticated;
revoke all on function public.lock_content_post_for_write(uuid, integer) from public, anon, authenticated;

-- RPCs: signed-in users only.
revoke all on function public.update_content_post(
  uuid, integer, text, text, public.content_post_status, timestamptz, public.content_change_source
) from public, anon;
revoke all on function public.archive_content_post(uuid, integer, public.content_change_source) from public, anon;
revoke all on function public.restore_content_post(uuid, integer, public.content_change_source) from public, anon;
grant execute on function public.update_content_post(
  uuid, integer, text, text, public.content_post_status, timestamptz, public.content_change_source
) to authenticated;
grant execute on function public.archive_content_post(uuid, integer, public.content_change_source) to authenticated;
grant execute on function public.restore_content_post(uuid, integer, public.content_change_source) to authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges (explicit: Supabase grants ALL on new tables by default)
-- ---------------------------------------------------------------------------

revoke all on table public.content_projects from public, anon, authenticated;
revoke all on table public.content_posts from public, anon, authenticated;
revoke all on table public.content_post_versions from public, anon, authenticated;

grant select on table public.content_projects to authenticated;
grant insert (id, workspace_id, name, description) on table public.content_projects to authenticated;
grant update (name, description, archived_at) on table public.content_projects to authenticated;

grant select on table public.content_posts to authenticated;
grant insert (id, workspace_id, project_id, title, body, status, scheduled_for, last_change_source)
  on table public.content_posts to authenticated;
-- No UPDATE / DELETE on content_posts: use the RPCs above.

grant select on table public.content_post_versions to authenticated;
-- No INSERT / UPDATE / DELETE on content_post_versions: written by trigger only.

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.content_projects enable row level security;
alter table public.content_posts enable row level security;
alter table public.content_post_versions enable row level security;

-- content_projects ---------------------------------------------------------

create policy "Members can view projects"
on public.content_projects for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "Owners and admins can create projects"
on public.content_projects for insert
to authenticated
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "Owners and admins can update and archive projects"
on public.content_projects for update
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- content_posts ----------------------------------------------------------

create policy "Members can view posts"
on public.content_posts for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "Members can create posts in active projects"
on public.content_posts for insert
to authenticated
with check (
  public.is_workspace_member(workspace_id)
  and exists (
    select 1
    from public.content_projects pr
    where pr.id = project_id
      and pr.workspace_id = content_posts.workspace_id
      and pr.archived_at is null
  )
);

-- content_post_versions --------------------------------------------------

create policy "Members can view post history"
on public.content_post_versions for select
to authenticated
using (public.is_workspace_member(workspace_id));
