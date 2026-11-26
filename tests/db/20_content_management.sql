-- Tests for M2 content management: content_projects, content_posts, content_post_versions.
-- Same approach as 10_rls_workspaces.sql: impersonate roles with SET ROLE + JWT claims.
-- Any failed assertion raises and aborts the run.

\set ON_ERROR_STOP on

-- Helpers (pg_temp functions live only for this session) ------------------------
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

-- Asserts that a statement fails with the given SQLSTATE.
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

-- Reads bypassing RLS (as the superuser running the tests), for verification only.
create or replace function pg_temp.post_version(p_id uuid) returns int language sql as $$
  select version from public.content_posts where id = p_id;
$$;
create or replace function pg_temp.history_count(p_id uuid) returns bigint language sql as $$
  select count(*) from public.content_post_versions where post_id = p_id;
$$;

-- Fixtures ---------------------------------------------------------------------
--   e1 Erin  : owner of W1         e2 Frank : admin of W1     e3 Grace : member of W1
--   e4 Heidi : no workspace         e5 Ivan  : owner of W2
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'erin@example.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'frank@example.test'),
  ('00000000-0000-0000-0000-0000000000e3', 'grace@example.test'),
  ('00000000-0000-0000-0000-0000000000e4', 'heidi@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'ivan@example.test');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
insert into public.workspaces (id, name) values ('20000000-0000-0000-0000-000000000001', 'Erin Media');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e2', 'admin'),
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e3', 'member');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e5');
insert into public.workspaces (id, name) values ('20000000-0000-0000-0000-000000000002', 'Ivan Labs');
insert into public.content_projects (id, workspace_id, name)
  values ('30000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000002', 'Ivan project');
select pg_temp.reset_actor();

-- 1. Projects ---------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
with p as (
  insert into public.content_projects (id, workspace_id, name, description)
  values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Blog', 'Main blog')
  returning created_by)
select pg_temp.assert(created_by = '00000000-0000-0000-0000-0000000000e1',
  'owner creates a project (INSERT ... RETURNING); created_by = auth.uid()') from p;
select pg_temp.assert_error(
  $q$insert into public.content_projects (workspace_id, name, created_by)
     values ('20000000-0000-0000-0000-000000000001', 'Spoof', '00000000-0000-0000-0000-0000000000e3')$q$,
  '42501', 'cannot set created_by on a project');
select pg_temp.assert_error(
  $q$insert into public.content_projects (workspace_id, name, archived_at)
     values ('20000000-0000-0000-0000-000000000001', 'Pre-archived', now())$q$,
  '42501', 'cannot set archived_at when creating a project');
select pg_temp.assert_error(
  $q$insert into public.content_projects (workspace_id, name) values ('20000000-0000-0000-0000-000000000001', '  ')$q$,
  '23514', 'blank project name is rejected');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
insert into public.content_projects (id, workspace_id, name)
  values ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Newsletter');
select pg_temp.assert(true, 'admin creates a project');
select pg_temp.assert(
  pg_temp.affected($q$update public.content_projects set name = 'Blog (EN)' where id = '30000000-0000-0000-0000-000000000001'$q$) = 1,
  'admin renames a project');
select pg_temp.assert_error(
  $q$update public.content_projects set workspace_id = '20000000-0000-0000-0000-000000000002'
     where id = '30000000-0000-0000-0000-000000000001'$q$,
  '42501', 'project cannot be moved to another workspace');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
select pg_temp.assert((select count(*) from public.content_projects) = 2, 'member sees the projects of their workspace');
select pg_temp.assert_error(
  $q$insert into public.content_projects (workspace_id, name) values ('20000000-0000-0000-0000-000000000001', 'Grace project')$q$,
  '42501', 'member cannot create a project');
select pg_temp.assert(
  pg_temp.affected($q$update public.content_projects set name = 'Grace rename' where id = '30000000-0000-0000-0000-000000000001'$q$) = 0,
  'member cannot rename a project');
select pg_temp.assert(
  pg_temp.affected($q$update public.content_projects set archived_at = now() where id = '30000000-0000-0000-0000-000000000001'$q$) = 0,
  'member cannot archive a project');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e4');
select pg_temp.assert((select count(*) from public.content_projects) = 0, 'outsider sees no projects');
select pg_temp.assert_error(
  $q$insert into public.content_projects (workspace_id, name) values ('20000000-0000-0000-0000-000000000001', 'Intruder')$q$,
  '42501', 'outsider cannot create a project in a foreign workspace');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e5');
select pg_temp.assert((select count(*) from public.content_projects) = 1, 'owner of W2 sees only W2 projects');
select pg_temp.assert(
  pg_temp.affected($q$update public.content_projects set name = 'pwned' where id = '30000000-0000-0000-0000-000000000001'$q$) = 0,
  'owner of another workspace cannot rename a W1 project');
select pg_temp.reset_actor();

-- 2. Creating posts ------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
with p as (
  insert into public.content_posts (id, workspace_id, project_id, title, body, scheduled_for)
  values ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
          '30000000-0000-0000-0000-000000000001', 'Hello', 'First draft', '2026-12-01 09:00+00')
  returning version, status, created_by, updated_by)
select pg_temp.assert(
  version = 1 and status = 'draft'
  and created_by = '00000000-0000-0000-0000-0000000000e3'
  and updated_by = '00000000-0000-0000-0000-0000000000e3',
  'member creates a post (INSERT ... RETURNING): version 1, draft, created_by/updated_by = auth.uid()') from p;
select pg_temp.assert(
  (select count(*) = 1 and bool_and(version = 1 and title = 'Hello' and changed_by = '00000000-0000-0000-0000-0000000000e3')
     from public.content_post_versions where post_id = '40000000-0000-0000-0000-000000000001'),
  'creating a post records version 1 in the history (same transaction)');
insert into public.content_posts (id, workspace_id, project_id, title, status, last_change_source)
values ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000001', 'Ready one', 'ready', 'agent');
select pg_temp.assert(true, 'member creates a post directly in ready status');

select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title, status)
     values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Pub', 'published')$q$,
  '42501', 'creating a post as published is rejected (M4: publish guard trigger)');
select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title, version)
     values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'V', 7)$q$,
  '42501', 'cannot choose the version of a new post');
select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title, created_by)
     values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'C',
             '00000000-0000-0000-0000-0000000000e1')$q$,
  '42501', 'cannot forge created_by of a new post');
select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title, published_at)
     values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'P', now())$q$,
  '42501', 'cannot set published_at');
select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title, archived_at)
     values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'A', now())$q$,
  '42501', 'cannot set archived_at when creating a post');
select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title)
     values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', repeat('x', 201))$q$,
  '23514', 'over-long title is rejected');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e5');
select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title)
     values ('20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'Cross')$q$,
  '42501', 'cannot attach a post to a project of another workspace');
select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title)
     values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Intrude')$q$,
  '42501', 'cannot create a post in a foreign workspace');
select pg_temp.assert((select count(*) from public.content_posts) = 0, 'owner of W2 sees no W1 posts');
select pg_temp.assert((select count(*) from public.content_post_versions) = 0, 'owner of W2 sees no W1 history');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e4');
select pg_temp.assert((select count(*) from public.content_posts) = 0, 'outsider sees no posts');
select pg_temp.reset_actor();

-- 3. Updating posts: only via RPC, with expected_version ------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select pg_temp.assert_error(
  $q$update public.content_posts set title = 'Direct' where id = '40000000-0000-0000-0000-000000000001'$q$,
  '42501', 'direct UPDATE of a post is denied, even for the owner');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.assert(
  (select version = 2 and title = 'Hello v2' and status = 'ready'
          and updated_by = '00000000-0000-0000-0000-0000000000e2'
     from public.update_content_post('40000000-0000-0000-0000-000000000001', 1,
            'Hello v2', 'Second draft', 'ready', '2026-12-02 09:00+00')),
  'update with the current expected_version succeeds and bumps the version');
select pg_temp.assert(pg_temp.history_count('40000000-0000-0000-0000-000000000001') = 2,
  'successful update adds exactly one history row');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 1,
       'Stale overwrite', 'old data', 'draft', null)$q$,
  'CP409', 'update with a stale expected_version is rejected');
select pg_temp.assert(
  pg_temp.post_version('40000000-0000-0000-0000-000000000001') = 2
  and (select title from public.content_posts where id = '40000000-0000-0000-0000-000000000001') = 'Hello v2',
  'stale update changed nothing');
select pg_temp.assert(pg_temp.history_count('40000000-0000-0000-0000-000000000001') = 2,
  'rejected update adds no history row');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', null,
       'No version', 'x', 'draft', null)$q$,
  '22023', 'expected_version is mandatory');
select pg_temp.reset_actor();

-- Two editors start from version 2: the first save wins, the second is rejected.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
select pg_temp.assert(
  (select version = 3 from public.update_content_post('40000000-0000-0000-0000-000000000001', 2,
     'Grace edit', 'Grace body', 'draft', null, 'agent')),
  'first of two concurrent editors saves (version 3)');
select pg_temp.reset_actor();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 2,
       'Frank edit', 'Frank body', 'draft', null)$q$,
  'CP409', 'second editor with the same base version is rejected (no lost update)');
select pg_temp.reset_actor();
select pg_temp.assert(
  (select changed_by = '00000000-0000-0000-0000-0000000000e3' and change_source = 'agent' and title = 'Grace edit'
     from public.content_post_versions
    where post_id = '40000000-0000-0000-0000-000000000001' and version = 3),
  'history records who changed the post and the change source');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select pg_temp.assert(
  (select version = 3 from public.update_content_post('40000000-0000-0000-0000-000000000001', 3,
     'Grace edit', 'Grace body', 'draft', null)),
  'saving unchanged content does not create a new version');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 3,
       'Go live', 'x', 'published', null)$q$,
  '42501', 'owner cannot publish via RPC');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 3,
       '   ', 'x', 'draft', null)$q$,
  '23514', 'RPC rejects a blank title');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 3,
       'x', 'x', null, null)$q$,
  '22023', 'RPC rejects a null status');
select pg_temp.assert(pg_temp.post_version('40000000-0000-0000-0000-000000000001') = 3,
  'rejected updates did not change the version');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-0000000000ff', 1, 'x', 'x', 'draft', null)$q$,
  'CP404', 'unknown post id is reported as not found');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e5');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 3, 'pwned', 'x', 'draft', null)$q$,
  'CP404', 'owner of another workspace cannot update a W1 post (not found)');
select pg_temp.assert_error(
  $q$select public.archive_content_post('40000000-0000-0000-0000-000000000001', 3)$q$,
  'CP404', 'owner of another workspace cannot archive a W1 post');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e4');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 3, 'pwned', 'x', 'draft', null)$q$,
  'CP404', 'outsider cannot update a post');
select pg_temp.reset_actor();

-- Signed-in role without a user id (no JWT sub).
set role authenticated;
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 3, 'x', 'x', 'draft', null)$q$,
  '42501', 'RPC rejects a caller without auth.uid()');
reset role;

-- 4. Archiving -------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
select pg_temp.assert_error(
  $q$select public.archive_content_post('40000000-0000-0000-0000-000000000001', 2)$q$,
  'CP409', 'archive with a stale expected_version is rejected');
select pg_temp.assert(
  (select version = 4 and archived_at is not null
     from public.archive_content_post('40000000-0000-0000-0000-000000000001', 3)),
  'member archives a post (version 4)');
select pg_temp.assert(
  (select archived_at is not null from public.content_post_versions
    where post_id = '40000000-0000-0000-0000-000000000001' and version = 4),
  'archiving is recorded in the history');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 4, 'x', 'x', 'draft', null)$q$,
  'CP423', 'archived post cannot be edited');
select pg_temp.assert(
  (select version = 5 and archived_at is null
     from public.restore_content_post('40000000-0000-0000-0000-000000000001', 4)),
  'member restores an archived post (version 5)');
select pg_temp.reset_actor();

-- Archiving a project freezes its posts.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.assert(
  pg_temp.affected($q$update public.content_projects set archived_at = '2000-01-01' where id = '30000000-0000-0000-0000-000000000001'$q$) = 1,
  'admin archives a project');
select pg_temp.assert(
  (select archived_at > '2020-01-01' from public.content_projects where id = '30000000-0000-0000-0000-000000000001'),
  'project archived_at is a server timestamp, not client-chosen');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
select pg_temp.assert_error(
  $q$insert into public.content_posts (workspace_id, project_id, title)
     values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Late')$q$,
  '42501', 'cannot create a post in an archived project');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 5, 'x', 'x', 'draft', null)$q$,
  'CP423', 'cannot edit a post of an archived project');
select pg_temp.assert(
  (select version = 2 from public.archive_content_post('40000000-0000-0000-0000-000000000002', 1)),
  'a post of an archived project can still be archived');
select pg_temp.assert_error(
  $q$select public.restore_content_post('40000000-0000-0000-0000-000000000002', 1)$q$,
  'CP409', 'restore with a stale version is rejected');
select pg_temp.reset_actor();
-- (post 2 is now at version 2; its version counter is per post)
select pg_temp.assert(pg_temp.post_version('40000000-0000-0000-0000-000000000002') = 2,
  'version counters are per post');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
select pg_temp.assert_error(
  $q$select public.restore_content_post('40000000-0000-0000-0000-000000000002', 2)$q$,
  'CP423', 'cannot restore a post while its project is archived');
select pg_temp.reset_actor();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select pg_temp.assert(
  pg_temp.affected($q$update public.content_projects set archived_at = null where id = '30000000-0000-0000-0000-000000000001'$q$) = 1,
  'owner restores the project');
select pg_temp.reset_actor();

-- 5. Publishing without an approved request is impossible for every writer -------------
-- Even the database superuser (bypasses RLS and grants) hits the M4 publish guard trigger.
select pg_temp.assert_error(
  $q$update public.content_posts set status = 'published' where id = '40000000-0000-0000-0000-000000000001'$q$,
  '42501', 'superuser cannot set a post to published without an approved request (publish guard)');
select pg_temp.assert_error(
  $q$update public.content_posts set published_at = now() where id = '40000000-0000-0000-0000-000000000001'$q$,
  '23514', 'superuser cannot set published_at (published_at consistency CHECK)');
select pg_temp.assert(
  (select count(*) from public.content_posts
    where status = 'published'
      and workspace_id in ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002')) = 0,
  'no post of this test is published');

-- 6. Permanent deletion is impossible --------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select pg_temp.assert_error($q$delete from public.content_posts$q$, '42501', 'owner cannot delete posts');
select pg_temp.assert_error($q$delete from public.content_projects$q$, '42501', 'owner cannot delete projects');
select pg_temp.assert_error($q$delete from public.content_post_versions$q$, '42501', 'owner cannot delete history');
select pg_temp.assert_error(
  $q$delete from public.workspaces where id = '20000000-0000-0000-0000-000000000001'$q$,
  '23503', 'owner cannot delete a workspace that still has content (ON DELETE RESTRICT)');
select pg_temp.reset_actor();
select pg_temp.assert((select count(*) from public.workspaces where id = '20000000-0000-0000-0000-000000000001') = 1,
  'workspace and its content survive the delete attempt');

-- 7. History is append-only ----------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select pg_temp.assert_error(
  $q$insert into public.content_post_versions (workspace_id, post_id, version, title, body, status, change_source)
     values ('20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 99, 'fake', 'fake', 'draft', 'user')$q$,
  '42501', 'users cannot insert history rows');
select pg_temp.assert_error(
  $q$update public.content_post_versions set title = 'rewritten'$q$,
  '42501', 'users cannot rewrite history');
select pg_temp.reset_actor();
select pg_temp.assert_error(
  $q$update public.content_post_versions set title = 'rewritten' where post_id = '40000000-0000-0000-0000-000000000001'$q$,
  '42501', 'even the table owner cannot rewrite history (trigger)');
select pg_temp.assert_error(
  $q$delete from public.content_post_versions where post_id = '40000000-0000-0000-0000-000000000001'$q$,
  '42501', 'even the table owner cannot delete history (trigger)');
select pg_temp.assert(
  pg_temp.history_count('40000000-0000-0000-0000-000000000001') = pg_temp.post_version('40000000-0000-0000-0000-000000000001'),
  'exactly one history row per version');

-- 8. Account deletion keeps content and history ------------------------------------------
delete from auth.users where id = '00000000-0000-0000-0000-0000000000e2';
select pg_temp.assert(
  (select created_by is null from public.content_projects where id = '30000000-0000-0000-0000-000000000002'),
  'deleting an account clears created_by of their project instead of deleting it');
select pg_temp.assert(
  pg_temp.post_version('40000000-0000-0000-0000-000000000001') = 5
  and pg_temp.history_count('40000000-0000-0000-0000-000000000001') = 5,
  'clearing user references does not create versions');
select pg_temp.assert(
  (select changed_by is null from public.content_post_versions
    where post_id = '40000000-0000-0000-0000-000000000001' and version = 2),
  'history rows of a deleted account are kept with changed_by = null');

-- 9. anon has no access ----------------------------------------------------------------------
select pg_temp.act_as_anon();
select pg_temp.assert_error($q$select * from public.content_projects$q$, '42501', 'anon cannot read projects');
select pg_temp.assert_error($q$select * from public.content_posts$q$, '42501', 'anon cannot read posts');
select pg_temp.assert_error($q$select * from public.content_post_versions$q$, '42501', 'anon cannot read history');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000001', 5, 'x', 'x', 'draft', null)$q$,
  '42501', 'anon cannot call update_content_post');
select pg_temp.assert_error(
  $q$select public.archive_content_post('40000000-0000-0000-0000-000000000001', 5)$q$,
  '42501', 'anon cannot call archive_content_post');
select pg_temp.reset_actor();

-- 10. Internal and trigger functions cannot be called directly --------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select pg_temp.assert_error(
  $q$select public.lock_content_post_for_write('40000000-0000-0000-0000-000000000001', 5)$q$,
  '42501', 'lock_content_post_for_write is not callable by users');
select pg_temp.assert_error(
  $q$select public.record_content_post_version()$q$,
  '42501', 'record_content_post_version is not callable by users');
select pg_temp.reset_actor();

-- 11. Catalog checks ---------------------------------------------------------------------------
select pg_temp.assert(
  (select bool_and(relrowsecurity) from pg_class
     where oid in ('public.content_projects'::regclass, 'public.content_posts'::regclass,
                   'public.content_post_versions'::regclass)),
  'RLS is enabled on all content tables');
select pg_temp.assert(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('content_projects', 'content_posts', 'content_post_versions')
      and cmd in ('DELETE', 'ALL')),
  'no DELETE policy exists on content tables');
select pg_temp.assert(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename in ('content_posts', 'content_post_versions')
      and cmd = 'UPDATE'),
  'no UPDATE policy exists on posts or history');
select pg_temp.assert(
  not has_table_privilege('authenticated', 'public.content_projects', 'DELETE')
  and not has_table_privilege('authenticated', 'public.content_posts', 'DELETE')
  and not has_table_privilege('authenticated', 'public.content_post_versions', 'DELETE')
  and not has_any_column_privilege('authenticated', 'public.content_posts', 'UPDATE')
  and not has_any_column_privilege('authenticated', 'public.content_post_versions', 'INSERT')
  and not has_any_column_privilege('authenticated', 'public.content_post_versions', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.content_posts', 'version', 'INSERT')
  and not has_column_privilege('authenticated', 'public.content_projects', 'workspace_id', 'UPDATE'),
  'authenticated has no DELETE, no post/history UPDATE, and no version/identity column writes');
select pg_temp.assert(
  not has_any_column_privilege('anon', 'public.content_projects', 'SELECT')
  and not has_any_column_privilege('anon', 'public.content_posts', 'SELECT')
  and not has_any_column_privilege('anon', 'public.content_post_versions', 'SELECT'),
  'anon has no privilege on content tables');
select pg_temp.assert(
  (select bool_and('search_path=""' = any (coalesce(p.proconfig, '{}')))
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef),
  'every SECURITY DEFINER function in public pins search_path to empty');
select pg_temp.assert(
  not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')),
  'anon cannot execute any SECURITY DEFINER function');
select pg_temp.assert(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  = array['approve_publish_request', 'archive_content_post', 'cancel_publish_request', 'claim_social_deliveries', 'claim_sports_auto_publish', 'claim_sports_news_review_notices',
          'finish_social_delivery', 'finish_sports_auto_publish', 'finish_sports_news_review_notice', 'get_sports_auto_publish_window', 'has_workspace_role', 'is_workspace_member', 'record_sports_news', 'record_sports_news_assessment', 'reject_publish_request', 'request_post_publish', 'restore_content_post',
          'shares_workspace_with', 'update_content_post'],
  'authenticated can execute exactly the intended SECURITY DEFINER functions');
select pg_temp.assert(
  (select count(*) = 2 from pg_constraint
    where conname in ('content_posts_published_at_consistency', 'content_posts_project_fkey')),
  'published_at consistency (M4) and same-workspace constraints exist');
select pg_temp.assert(
  (select bool_and(confdeltype = 'r') from pg_constraint
    where contype = 'f'
      and conrelid in ('public.content_projects'::regclass, 'public.content_posts'::regclass,
                       'public.content_post_versions'::regclass)
      and confrelid <> 'auth.users'::regclass),
  'all content foreign keys use ON DELETE RESTRICT');

-- 12. Regression: a status-only change keeps title, body and schedule exactly --------
-- The app's setPostStatus sends the stored values back unchanged (as JSON text,
-- like PostgREST). Values that validation would normalise must survive intact.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
insert into public.content_posts (id, workspace_id, project_id, title, body, scheduled_for)
values ('40000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000001', '  Spaced title  ', e'\n  indented body \n\n',
        '2026-12-01 02:00:00.123456+00');
select pg_temp.assert(
  (select (to_json(scheduled_for) #>> '{}')::timestamptz = scheduled_for
     from public.content_posts where id = '40000000-0000-0000-0000-000000000003'),
  'scheduled_for survives a JSON round trip with microsecond precision');
select pg_temp.assert(
  (with cur as (
     select title, body, to_json(scheduled_for) #>> '{}' as sched
     from public.content_posts where id = '40000000-0000-0000-0000-000000000003')
   select r.version = 2 and r.status = 'ready'
          and r.title = '  Spaced title  '
          and r.body = e'\n  indented body \n\n'
          and r.scheduled_for = '2026-12-01 02:00:00.123456+00'::timestamptz
     from cur,
          public.update_content_post('40000000-0000-0000-0000-000000000003', 1,
                                     cur.title, cur.body, 'ready', cur.sched::timestamptz) r),
  'status-only change (draft -> ready) leaves title, body and schedule byte-identical');
select pg_temp.assert(
  (select title = '  Spaced title  ' and body = e'\n  indented body \n\n' and status = 'ready'
          and scheduled_for = '2026-12-01 02:00:00.123456+00'::timestamptz
     from public.content_post_versions
    where post_id = '40000000-0000-0000-0000-000000000003' and version = 2),
  'history of the status change records the unchanged title, body and schedule');
select pg_temp.assert(
  (with cur as (
     select title, body, scheduled_for from public.content_posts
     where id = '40000000-0000-0000-0000-000000000003')
   select r.version = 3 and r.status = 'draft' and r.title = '  Spaced title  '
     from cur,
          public.update_content_post('40000000-0000-0000-0000-000000000003', 2,
                                     cur.title, cur.body, 'draft', cur.scheduled_for) r),
  'switching back ready -> draft also keeps the title');
select pg_temp.assert_error(
  $q$select public.update_content_post('40000000-0000-0000-0000-000000000003', 2,
       '  Spaced title  ', e'\n  indented body \n\n', 'ready', '2026-12-01 02:00:00.123456+00')$q$,
  'CP409', 'a status change based on a stale version is rejected');
select pg_temp.reset_actor();

\echo 'All content management tests passed.'
