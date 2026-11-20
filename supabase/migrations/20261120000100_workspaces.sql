-- ContentPilot AI — M1: workspaces and workspace membership with Row Level Security.
--
-- Security model
--   * Every table has RLS enabled. Nothing is readable by the `anon` role.
--   * A user sees a workspace (and its member list) only if they are a member.
--   * Creating a workspace makes the creator its `owner` (trigger, same transaction).
--   * Only owners/admins manage members; only owners can grant or touch `owner` rows.
--   * A workspace can never be left without an owner.
--   * Membership checks run in SECURITY DEFINER helpers to avoid recursive RLS on
--     workspace_members. They take no caller-controlled user id: they always use auth.uid().

-- ---------------------------------------------------------------------------
-- Types and tables
-- ---------------------------------------------------------------------------

create type public.workspace_role as enum ('owner', 'admin', 'member');

create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 100),
  created_by  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.workspaces is 'Tenant boundary. All future content data belongs to a workspace.';

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         public.workspace_role not null default 'member',
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

comment on table public.workspace_members is 'Which users belong to which workspace, and with which role.';

create index workspace_members_user_id_idx on public.workspace_members (user_id);
create index workspaces_created_by_idx on public.workspaces (created_by);

-- ---------------------------------------------------------------------------
-- Helper functions (used by policies)
-- ---------------------------------------------------------------------------

-- True when the current user is a member of the workspace.
create function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
  );
$$;

-- True when the current user holds one of the given roles in the workspace.
create function public.has_workspace_role(
  p_workspace_id uuid,
  p_roles public.workspace_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.has_workspace_role(uuid, public.workspace_role[]) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function public.set_updated_at();

-- The creator becomes the owner of a new workspace, atomically.
create function public.add_workspace_creator_as_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

revoke all on function public.add_workspace_creator_as_owner() from public, anon, authenticated;

create trigger workspaces_add_creator_as_owner
after insert on public.workspaces
for each row execute function public.add_workspace_creator_as_owner();

-- created_by is immutable once set.
create function public.prevent_workspace_creator_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'workspaces.created_by cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger workspaces_prevent_creator_change
before update on public.workspaces
for each row execute function public.prevent_workspace_creator_change();

-- A workspace must always keep at least one owner. Removing or demoting the
-- last owner is rejected, except when the whole workspace is being deleted
-- (ON DELETE CASCADE), in which case the parent row is already gone.
create function public.ensure_workspace_keeps_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;

  if tg_op = 'UPDATE' and new.role = 'owner' and new.workspace_id = old.workspace_id then
    return new;
  end if;

  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return coalesce(new, old);
  end if;

  if not exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = old.workspace_id
      and m.role = 'owner'
      and m.user_id <> old.user_id
  ) then
    raise exception 'A workspace must keep at least one owner' using errcode = '23514';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function public.ensure_workspace_keeps_owner() from public, anon, authenticated;

create trigger workspace_members_keep_owner
before update or delete on public.workspace_members
for each row execute function public.ensure_workspace_keeps_owner();

-- Membership rows may not be moved between workspaces or users.
create function public.prevent_membership_identity_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.user_id is distinct from old.user_id then
    raise exception 'Only the role of a membership can be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger workspace_members_identity_immutable
before update on public.workspace_members
for each row execute function public.prevent_membership_identity_change();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on table public.workspaces from anon, public;
revoke all on table public.workspace_members from anon, public;
grant select, insert, update, delete on table public.workspaces to authenticated;
grant select, insert, update, delete on table public.workspace_members to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

-- workspaces ---------------------------------------------------------------

create policy "Members can view their workspaces"
on public.workspaces for select
to authenticated
using (public.is_workspace_member(id));
-- Note: INSERT ... RETURNING checks this policy before the owner trigger runs, so
-- clients insert with a client-generated id and no RETURNING, then read it back.

create policy "Users can create workspaces they own"
on public.workspaces for insert
to authenticated
with check (created_by = (select auth.uid()));

create policy "Owners and admins can update workspaces"
on public.workspaces for update
to authenticated
using (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]))
with check (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]));

create policy "Owners can delete workspaces"
on public.workspaces for delete
to authenticated
using (public.has_workspace_role(id, array['owner']::public.workspace_role[]));

-- workspace_members ------------------------------------------------------

create policy "Members can view fellow members"
on public.workspace_members for select
to authenticated
using (public.is_workspace_member(workspace_id));

-- Owners may add anyone with any role; admins may add only admins/members.
create policy "Owners and admins can add members"
on public.workspace_members for insert
to authenticated
with check (
  public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])
  or (
    role <> 'owner'
    and public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[])
  )
);

-- Owners may change any role; admins may change non-owner rows to non-owner roles.
create policy "Owners and admins can change roles"
on public.workspace_members for update
to authenticated
using (
  public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])
  or (
    role <> 'owner'
    and public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[])
  )
)
with check (
  public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])
  or (
    role <> 'owner'
    and public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[])
  )
);

-- Owners may remove anyone; admins may remove non-owners; anyone may leave.
create policy "Owners and admins can remove members; users can leave"
on public.workspace_members for delete
to authenticated
using (
  user_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])
  or (
    role <> 'owner'
    and public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[])
  )
);
