-- Tests for M4.5.2 user_profiles: RLS, forged user ids, write rights, cross-workspace reads.

\set ON_ERROR_STOP on

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

create or replace function pg_temp.assert_error(p_sql text, p_sqlstate text, p_msg text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_sqlstate then
      raise exception 'ASSERTION FAILED: % (expected SQLSTATE %, got %: %)', p_msg, p_sqlstate, sqlstate, sqlerrm;
    end if;
    raise notice 'ok - % (rejected %: %)', p_msg, sqlstate, sqlerrm;
    return;
  end;
  raise exception 'ASSERTION FAILED: % (statement was allowed)', p_msg;
end $$;

create or replace function pg_temp.affected(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;

-- Fixtures ---------------------------------------------------------------------
--   e1 Uma: owner of WU   e2 Vic: member of WU   e3 Wes: owner of WV (outsider to WU)
--   e4 Xia: member of WU and WV (shares a workspace with everyone)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000005e1', 'uma@example.test'),
  ('00000000-0000-0000-0000-0000000005e2', 'vic@example.test'),
  ('00000000-0000-0000-0000-0000000005e3', 'wes@example.test'),
  ('00000000-0000-0000-0000-0000000005e4', 'xia@example.test');

select pg_temp.act_as('00000000-0000-0000-0000-0000000005e1');
insert into public.workspaces (id, name) values ('ee000000-0000-0000-0000-0000000000a1', 'WU');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('ee000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000005e2', 'member'),
  ('ee000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000005e4', 'member');
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000005e3');
insert into public.workspaces (id, name) values ('ee000000-0000-0000-0000-0000000000a2', 'WV');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('ee000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000005e4', 'member');
select pg_temp.reset_actor();

-- 1. Structure and privileges --------------------------------------------------------
select pg_temp.assert(
  (select relrowsecurity from pg_class where oid = 'public.user_profiles'::regclass),
  'RLS is enabled on user_profiles');
select pg_temp.assert(
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'user_profiles' and column_name ilike '%email%'),
  'user_profiles has no email column');
select pg_temp.assert(
  has_table_privilege('authenticated', 'public.user_profiles', 'SELECT')
  and has_column_privilege('authenticated', 'public.user_profiles', 'display_name', 'INSERT')
  and has_column_privilege('authenticated', 'public.user_profiles', 'display_name', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_profiles', 'user_id', 'INSERT')
  and not has_column_privilege('authenticated', 'public.user_profiles', 'user_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_profiles', 'created_at', 'INSERT')
  and not has_column_privilege('authenticated', 'public.user_profiles', 'updated_at', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.user_profiles', 'DELETE'),
  'authenticated: SELECT, INSERT/UPDATE of display_name only, no DELETE');
select pg_temp.assert(
  not has_any_column_privilege('anon', 'public.user_profiles', 'SELECT')
  and not has_any_column_privilege('anon', 'public.user_profiles', 'INSERT')
  and not has_function_privilege('anon', 'public.shares_workspace_with(uuid)', 'EXECUTE'),
  'anon has no access to profiles');
select pg_temp.assert(
  not has_table_privilege('authenticated', 'auth.users', 'SELECT')
  and not has_table_privilege('anon', 'auth.users', 'SELECT'),
  'no client role can read auth.users');
select pg_temp.assert(
  not has_function_privilege('authenticated', 'public.user_profiles_before_write()', 'EXECUTE'),
  'the trigger function cannot be called by clients');

-- 2. Own profile: create and update ------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000005e1');
insert into public.user_profiles (display_name) values ('Uma Nguyễn');
select pg_temp.assert(
  (select user_id = '00000000-0000-0000-0000-0000000005e1' and created_at > now() - interval '1 minute'
     from public.user_profiles where display_name = 'Uma Nguyễn'),
  'a user creates their own profile; user_id comes from auth.uid()');
select pg_temp.assert(
  pg_temp.affected($q$update public.user_profiles set display_name = 'Uma N.' where user_id = '00000000-0000-0000-0000-0000000005e1'$q$) = 1,
  'a user renames themselves');
select pg_temp.assert_error(
  $q$insert into public.user_profiles (display_name) values ('Uma again')$q$,
  '23505', 'only one profile per user');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000005e2');
insert into public.user_profiles (display_name) values ('Vic');
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000005e3');
insert into public.user_profiles (display_name) values ('Wes');
select pg_temp.reset_actor();
-- e4 (Xia) has no profile: missing profiles must be handled by the app.

-- 3. Forged user ids, foreign rows, deletion ---------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000005e2');
select pg_temp.assert_error(
  $q$insert into public.user_profiles (user_id, display_name) values ('00000000-0000-0000-0000-0000000005e4', 'Fake Xia')$q$,
  '42501', 'cannot create a profile for another user (user_id not insertable)');
select pg_temp.assert_error(
  $q$update public.user_profiles set user_id = '00000000-0000-0000-0000-0000000005e4' where user_id = '00000000-0000-0000-0000-0000000005e2'$q$,
  '42501', 'cannot move a profile to another user id');
select pg_temp.assert_error(
  $q$update public.user_profiles set created_at = now() - interval '1 year'$q$,
  '42501', 'cannot change created_at');
select pg_temp.assert(
  pg_temp.affected($q$update public.user_profiles set display_name = 'Hacked' where user_id = '00000000-0000-0000-0000-0000000005e1'$q$) = 0,
  'cannot rename a fellow member (0 rows)');
select pg_temp.assert(
  pg_temp.affected($q$update public.user_profiles set display_name = 'Hacked' where user_id = '00000000-0000-0000-0000-0000000005e3'$q$) = 0,
  'cannot rename an outsider (0 rows)');
select pg_temp.assert_error(
  $q$delete from public.user_profiles where user_id = '00000000-0000-0000-0000-0000000005e1'$q$,
  '42501', 'cannot delete another profile');
select pg_temp.assert_error(
  $q$delete from public.user_profiles where user_id = '00000000-0000-0000-0000-0000000005e2'$q$,
  '42501', 'cannot delete even their own profile (no DELETE privilege)');
select pg_temp.reset_actor();
-- The trigger sets user_id from auth.uid() even for code that may write user_id.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005e4","role":"authenticated"}', false);
insert into public.user_profiles (user_id, display_name) values ('00000000-0000-0000-0000-0000000005e3', 'Xia');
select set_config('request.jwt.claims', '', false);
select pg_temp.assert(
  (select user_id = '00000000-0000-0000-0000-0000000005e4' from public.user_profiles where display_name = 'Xia'),
  'even a privileged writer cannot choose user_id: the trigger uses auth.uid()');
select pg_temp.assert_error(
  $q$insert into public.user_profiles (display_name) values ('No session')$q$,
  '42501', 'no profile without a signed-in user');
select pg_temp.assert(
  (select display_name = 'Wes' from public.user_profiles where user_id = '00000000-0000-0000-0000-0000000005e3'),
  'outsider profile unchanged');

-- 4. Validation -------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000005e2');
select pg_temp.assert_error($q$update public.user_profiles set display_name = '' $q$, '23514', 'empty name rejected');
select pg_temp.assert_error($q$update public.user_profiles set display_name = '  Vic  ' $q$, '23514', 'untrimmed name rejected');
select pg_temp.assert_error($q$update public.user_profiles set display_name = repeat('a', 61) $q$, '23514', 'name over 60 characters rejected');
select pg_temp.assert_error($q$update public.user_profiles set display_name = E'Vic\nNew line' $q$, '23514', 'control characters rejected');
select pg_temp.assert_error($q$update public.user_profiles set display_name = E'Vic\u0085x' $q$, '23514', 'C1 control characters rejected');
select pg_temp.assert(
  pg_temp.affected($q$update public.user_profiles set display_name = 'Nguyễn Thị Ánh' $q$) = 1,
  'Vietnamese letters with diacritics accepted');
select pg_temp.assert(
  pg_temp.affected($q$update public.user_profiles set display_name = repeat('ă', 60) $q$) = 1,
  '60 Vietnamese characters accepted');
update public.user_profiles set display_name = 'Vic';
select pg_temp.reset_actor();

-- 5. Cross-workspace reads -------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000005e2');
select pg_temp.assert(
  (select array_agg(display_name order by display_name) from public.user_profiles) = array['Uma N.', 'Vic', 'Xia'],
  'a member reads own and fellow members (WU) profiles, not the outsider');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000005e3');
select pg_temp.assert(
  (select array_agg(display_name order by display_name) from public.user_profiles) = array['Wes', 'Xia'],
  'the outsider reads only own and WV members (Xia), never Uma or Vic');
select pg_temp.assert(
  not public.shares_workspace_with('00000000-0000-0000-0000-0000000005e1')
  and public.shares_workspace_with('00000000-0000-0000-0000-0000000005e4'),
  'shares_workspace_with reflects real memberships');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000005e4');
select pg_temp.assert(
  (select count(*) from public.user_profiles) = 4,
  'a member of both workspaces reads everyone they share a workspace with');
select pg_temp.reset_actor();

select pg_temp.act_as_anon();
select pg_temp.assert_error($q$select count(*) from public.user_profiles$q$, '42501', 'anon cannot read profiles');
select pg_temp.reset_actor();

-- Leaving the workspace removes visibility.
delete from public.workspace_members
 where workspace_id = 'ee000000-0000-0000-0000-0000000000a1' and user_id = '00000000-0000-0000-0000-0000000005e2';
select pg_temp.act_as('00000000-0000-0000-0000-0000000005e2');
select pg_temp.assert(
  (select array_agg(display_name) from public.user_profiles) = array['Vic'],
  'after leaving the workspace, former colleagues are no longer readable');
select pg_temp.reset_actor();

-- 6. Account deletion removes the profile --------------------------------------------------------
delete from auth.users where id = '00000000-0000-0000-0000-0000000005e2';
select pg_temp.assert(
  not exists (select 1 from public.user_profiles where user_id = '00000000-0000-0000-0000-0000000005e2'),
  'deleting the account deletes its profile');
