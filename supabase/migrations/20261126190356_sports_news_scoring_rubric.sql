begin;

alter table public.sports_news_items
  add column assessment jsonb check (
    assessment is null or (jsonb_typeof(assessment) = 'object' and length(assessment::text) <= 5000)
  );

-- Keep the previous RPC callable by deployments built before the migration.
create function public.record_sports_news_assessment(
  p_workspace_id uuid, p_project_id uuid, p_source_url text, p_headline_key text,
  p_score numeric, p_title text, p_body text, p_image text, p_reason text,
  p_destinations uuid[], p_assessment jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_post uuid;
begin
  v_post := public.record_sports_news(
    p_workspace_id, p_project_id, p_source_url, p_headline_key, p_score,
    p_title, p_body, p_image, p_reason, p_destinations
  );

  update public.sports_news_items n
     set assessment = p_assessment
   where n.workspace_id = p_workspace_id and n.project_id = p_project_id
     and n.source_url = p_source_url and n.headline_key = p_headline_key
     and n.post_id is not distinct from v_post and n.score = p_score
     and n.assessment is null;
  return v_post;
end
$$;

revoke all on function public.record_sports_news_assessment(
  uuid, uuid, text, text, numeric, text, text, text, text, uuid[], jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_sports_news_assessment(
  uuid, uuid, text, text, numeric, text, text, text, text, uuid[], jsonb
) to authenticated;

commit;
