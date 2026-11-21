-- ContentPilot AI — M4.5.2: user profiles (display names).
--
-- What is stored: a display name chosen by the user. NOT stored: email or any
-- other data from auth.users. Clients are not given any access to auth.users.
--
-- Security model
--   * RLS on; nothing granted to anon.
--   * Read: your own profile, or the profile of someone who shares at least one
--     workspace with you (so names can be shown in approval history). Outsiders
--     cannot read it. The display name is therefore visible in every workspace
--     the user belongs to (approved design decision).
--   * Write: only your own row. INSERT / UPDATE are granted on display_name only;
--     user_id is set from auth.uid() by a trigger (cannot be forged) and is
--     immutable. No DELETE privilege: the row is removed with the account
--     (ON DELETE CASCADE).
--   * The display name is trimmed by the client and checked here: 1–60
--     characters, no leading/trailing spaces, no C0/C1 control characters.
--
-- SECURITY DEFINER function (search_path = '', no caller-supplied user id other
-- than the profile being checked, EXECUTE revoked from public/anon):
--   * shares_workspace_with(p_user_id): true when the caller and p_user_id are
--     members of a common workspace. Needed by the SELECT policy (it reads
--     workspace_members of other users, which RLS would otherwise filter).

create table public.user_profiles (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null
    constraint user_profiles_display_name_check check (
      display_name = btrim(display_name)
      and char_length(display_name) between 1 and 60
      -- No C0/C1 control characters (explicit ranges: independent of the locale).
      and display_name !~ '[\x01-\x1f\x7f-\x9f]'
    ),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.user_profiles is
  'Display names of users (no email). Readable by the user and by members of a shared workspace.';

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create function public.user_profiles_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.user_id := (select auth.uid());
    if new.user_id is null then
      raise exception 'Not authenticated' using errcode = '42501';
    end if;
    new.created_at := now();
  else
    if new.user_id is distinct from old.user_id or new.created_at is distinct from old.created_at then
      raise exception 'Profile identity cannot be changed' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger user_profiles_before_write
before insert or update on public.user_profiles
for each row execute function public.user_profiles_before_write();

-- ---------------------------------------------------------------------------
-- Helper for the read policy
-- ---------------------------------------------------------------------------

create function public.shares_workspace_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members me
    join public.workspace_members them on them.workspace_id = me.workspace_id
    where me.user_id = (select auth.uid())
      and them.user_id = p_user_id
  );
$$;

revoke all on function public.user_profiles_before_write() from public, anon, authenticated;
revoke all on function public.shares_workspace_with(uuid) from public, anon;
grant execute on function public.shares_workspace_with(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges (explicit: Supabase grants ALL on new tables by default)
-- ---------------------------------------------------------------------------

revoke all on table public.user_profiles from public, anon, authenticated;
grant select on table public.user_profiles to authenticated;
grant insert (display_name) on table public.user_profiles to authenticated;
grant update (display_name) on table public.user_profiles to authenticated;
-- No DELETE: a profile disappears with its account.

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.user_profiles enable row level security;

create policy "Users read their own profile and those of fellow workspace members"
on public.user_profiles for select
to authenticated
using (user_id = (select auth.uid()) or public.shares_workspace_with(user_id));

create policy "Users create their own profile"
on public.user_profiles for insert
to authenticated
with check (user_id = (select auth.uid()));

create policy "Users update their own profile"
on public.user_profiles for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));
