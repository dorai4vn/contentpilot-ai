begin;

alter table public.sports_news_items
  drop constraint sports_news_items_check,
  add constraint sports_news_image_requires_post check (image_base64 is null or post_id is not null),
  add column has_image boolean generated always as (image_base64 is not null) stored;

-- Later revisions may have their own photo. The first version keeps its
-- original bytes so earlier reviews always show the snapshot they reviewed.
create table public.sports_news_revision_photos (
  post_id uuid not null references public.sports_news_items(post_id) on delete cascade,
  post_version integer not null check (post_version > 1),
  image_base64 text not null check (length(image_base64) between 1 and 2000000),
  source_url text not null,
  license text not null,
  author text,
  primary key (post_id, post_version),
  foreign key (post_id, post_version) references public.content_post_versions(post_id, version) on delete cascade
);

alter table public.sports_news_revision_photos enable row level security;
revoke all on public.sports_news_revision_photos from public, anon, authenticated, service_role;
grant select on public.sports_news_revision_photos to authenticated;
create policy sports_news_revision_photo_member_read on public.sports_news_revision_photos
for select to authenticated using (
  exists (select 1 from public.sports_news_items n where n.post_id = sports_news_revision_photos.post_id)
);

commit;
