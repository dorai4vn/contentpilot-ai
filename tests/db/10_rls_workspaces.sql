-- RLS tests for workspaces / workspace_members.
-- Runs as a superuser, impersonating roles with SET ROLE + JWT claims, exactly the way
-- PostgREST does for Supabase requests. Any failed assertion raises and aborts.

\set ON_ERROR_STOP on

-- Fixtures -------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@example.test'),
  ('00000000-0000-0000-0000-00000000000d', 'dave@example.test');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  execute 'set role anon';
end $$;

create or replace function pg_temp.reset_actor() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
end $$;

create or replace function pg_temp.assert(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'ASSERTION FAILED: %', p_msg;
  end if;
  raise notice 'ok - %', p_msg;
end $$;

-- Runs a statement and asserts that it is rejected (any error).
create or replace function pg_temp.assert_rejected(p_sql text, p_msg text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok - % (rejected: %)', p_msg, sqlerrm;
    return;
  end;
  raise exception 'ASSERTION FAILED: % (statement was allowed)', p_msg;
end $$;

-- Runs a statement and returns the affected row count.
create or replace function pg_temp.affected(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;

-- 1. Creating a workspace -----------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.workspaces (id, name) values ('10000000-0000-0000-0000-000000000001', 'Alice Studio');
select pg_temp.assert(
  (select role from public.workspace_members
     where workspace_id = '10000000-0000-0000-0000-000000000001'
       and user_id = '00000000-0000-0000-0000-00000000000a') = 'owner',
  'creator automatically becomes owner');
select pg_temp.assert(
  (select created_by from public.workspaces where id = '10000000-0000-0000-0000-000000000001')
    = '00000000-0000-0000-0000-00000000000a',
  'created_by defaults to auth.uid()');
select pg_temp.assert_rejected(
  $q$insert into public.workspaces (name, created_by) values ('Spoof', '00000000-0000-0000-0000-00000000000b')$q$,
  'cannot create a workspace on behalf of another user');
select pg_temp.assert_rejected(
  $q$insert into public.workspaces (name) values ('   ')$q$,
  'blank workspace name is rejected');

-- Alice adds Bob as admin and Carol as member.
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'admin'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'member');
select pg_temp.reset_actor();

-- 2. Isolation: non-members see nothing ---------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.assert((select count(*) from public.workspaces) = 0, 'non-member sees no workspaces');
select pg_temp.assert((select count(*) from public.workspace_members) = 0, 'non-member sees no memberships');
select pg_temp.assert(
  pg_temp.affected($q$update public.workspaces set name = 'pwned' where id = '10000000-0000-0000-0000-000000000001'$q$) = 0,
  'non-member cannot rename a workspace');
select pg_temp.assert(
  pg_temp.affected($q$delete from public.workspaces where id = '10000000-0000-0000-0000-000000000001'$q$) = 0,
  'non-member cannot delete a workspace');
select pg_temp.assert_rejected(
  $q$insert into public.workspace_members (workspace_id, user_id, role)
     values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'owner')$q$,
  'non-member cannot add themselves to a workspace');
select pg_temp.reset_actor();

-- 3. anon role has no access at all --------------------------------------------
select pg_temp.act_as_anon();
select pg_temp.assert_rejected($q$select * from public.workspaces$q$, 'anon cannot read workspaces');
select pg_temp.assert_rejected($q$select * from public.workspace_members$q$, 'anon cannot read memberships');
select pg_temp.assert_rejected($q$insert into public.workspaces (name) values ('x')$q$, 'anon cannot create workspaces');
select pg_temp.assert((public.health_check() ->> 'ok')::boolean, 'anon can call health_check()');
select pg_temp.reset_actor();

-- 4. Member permissions ---------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.assert((select count(*) from public.workspaces) = 1, 'member sees their workspace');
select pg_temp.assert((select count(*) from public.workspace_members) = 3, 'member sees fellow members');
select pg_temp.assert(
  pg_temp.affected($q$update public.workspaces set name = 'Carol rename' where id = '10000000-0000-0000-0000-000000000001'$q$) = 0,
  'plain member cannot rename workspace');
select pg_temp.assert(
  pg_temp.affected($q$update public.workspace_members set role = 'owner'
     where user_id = '00000000-0000-0000-0000-00000000000c'$q$) = 0,
  'member cannot promote themselves');
select pg_temp.assert_rejected(
  $q$insert into public.workspace_members (workspace_id, user_id, role)
     values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'member')$q$,
  'plain member cannot invite others');
select pg_temp.reset_actor();

-- 5. Admin permissions ------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.assert(
  pg_temp.affected($q$update public.workspaces set name = 'Alice Studio (renamed)' where id = '10000000-0000-0000-0000-000000000001'$q$) = 1,
  'admin can rename workspace');
select pg_temp.assert(
  pg_temp.affected($q$delete from public.workspaces where id = '10000000-0000-0000-0000-000000000001'$q$) = 0,
  'admin cannot delete workspace');
select pg_temp.assert_rejected(
  $q$insert into public.workspace_members (workspace_id, user_id, role)
     values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'owner')$q$,
  'admin cannot grant owner role');
select pg_temp.assert_rejected(
  $q$update public.workspace_members set role = 'owner' where user_id = '00000000-0000-0000-0000-00000000000b'$q$,
  'admin cannot promote themselves to owner');
select pg_temp.assert(
  pg_temp.affected($q$update public.workspace_members set role = 'member'
     where user_id = '00000000-0000-0000-0000-00000000000a'$q$) = 0,
  'admin cannot demote the owner');
select pg_temp.assert(
  pg_temp.affected($q$delete from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000a'$q$) = 0,
  'admin cannot remove the owner');
insert into public.workspace_members (workspace_id, user_id, role)
  values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'member');
select pg_temp.assert(true, 'admin can add a member');
select pg_temp.assert_rejected(
  $q$update public.workspaces set created_by = '00000000-0000-0000-0000-00000000000b' where id = '10000000-0000-0000-0000-000000000001'$q$,
  'created_by is immutable');
select pg_temp.assert_rejected(
  $q$update public.workspace_members set user_id = '00000000-0000-0000-0000-00000000000b'
     where user_id = '00000000-0000-0000-0000-00000000000d'$q$,
  'membership identity is immutable');
select pg_temp.reset_actor();

-- 6. Leaving and last-owner protection ---------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.assert(
  pg_temp.affected($q$delete from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000d'$q$) = 1,
  'member can leave a workspace');
select pg_temp.assert((select count(*) from public.workspaces) = 0, 'after leaving, workspace is no longer visible');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.assert_rejected(
  $q$delete from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000a'$q$,
  'last owner cannot leave');
select pg_temp.assert_rejected(
  $q$update public.workspace_members set role = 'admin' where user_id = '00000000-0000-0000-0000-00000000000a'$q$,
  'last owner cannot demote themselves');
update public.workspace_members set role = 'owner' where user_id = '00000000-0000-0000-0000-00000000000b';
select pg_temp.assert(
  pg_temp.affected($q$update public.workspace_members set role = 'admin' where user_id = '00000000-0000-0000-0000-00000000000a'$q$) = 1,
  'an owner can step down once another owner exists');
select pg_temp.reset_actor();

-- 7. Deleting a workspace cascades cleanly -----------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.assert(
  pg_temp.affected($q$delete from public.workspaces where id = '10000000-0000-0000-0000-000000000001'$q$) = 1,
  'owner can delete workspace');
select pg_temp.reset_actor();
select pg_temp.assert((select count(*) from public.workspace_members) = 0, 'memberships are removed with the workspace');

-- 8. RLS is actually enabled ---------------------------------------------------------
select pg_temp.assert(
  (select bool_and(relrowsecurity) from pg_class
     where oid in ('public.workspaces'::regclass, 'public.workspace_members'::regclass)),
  'RLS is enabled on all workspace tables');

\echo 'All RLS tests passed.'
