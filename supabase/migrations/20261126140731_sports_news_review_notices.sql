begin;

alter table public.sports_news_items
  add column review_notice_sent_at timestamptz,
  add column review_notice_claim uuid,
  add column review_notice_claimed_at timestamptz;

create index sports_news_review_notices_pending
  on public.sports_news_items (project_id, created_at)
  where post_id is not null and review_notice_sent_at is null;

create function public.claim_sports_news_review_notices(p_workspace_id uuid, p_project_id uuid)
returns table (post_id uuid, claim_id uuid, title text, score numeric, request_ids uuid[])
language plpgsql security definer set search_path = '' as $$
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;

  return query
  with candidates as (
    select n.post_id, pending.ids, v.title
    from public.sports_news_items n
    join public.content_post_versions v on v.post_id = n.post_id and v.version = 1
    cross join lateral (
      select array_agg(r.id order by r.requested_at, r.id) as ids
      from public.content_publish_requests r
      join public.publishing_destinations d on d.id = r.destination_id and d.status = 'active'
      where r.workspace_id = n.workspace_id and r.post_id = n.post_id
        and r.post_version = 1 and r.status = 'pending' and r.expires_at > now()
    ) pending
    where n.workspace_id = p_workspace_id and n.project_id = p_project_id
      and n.review_notice_sent_at is null and pending.ids is not null
      and (n.review_notice_claimed_at is null or n.review_notice_claimed_at < now() - interval '5 minutes')
    order by n.created_at
    limit 6 for update of n skip locked
  )
  update public.sports_news_items n
     set review_notice_claim = gen_random_uuid(), review_notice_claimed_at = now()
    from candidates c where n.post_id = c.post_id
  returning n.post_id, n.review_notice_claim, c.title, n.score, c.ids;
end
$$;

create function public.finish_sports_news_review_notice(
  p_workspace_id uuid, p_post_id uuid, p_claim_id uuid, p_sent boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not contentpilot_private.can_run_news(p_workspace_id) then
    raise exception 'Worker is not authorized' using errcode = '42501';
  end if;

  update public.sports_news_items n
     set review_notice_sent_at = case when p_sent then now() end,
         review_notice_claim = null,
         review_notice_claimed_at = null
   where n.workspace_id = p_workspace_id and n.post_id = p_post_id
     and n.review_notice_claim = p_claim_id and n.review_notice_sent_at is null;
  return found;
end
$$;

revoke all on function public.claim_sports_news_review_notices(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.finish_sports_news_review_notice(uuid, uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_sports_news_review_notices(uuid, uuid) to authenticated;
grant execute on function public.finish_sports_news_review_notice(uuid, uuid, uuid, boolean) to authenticated;

commit;
