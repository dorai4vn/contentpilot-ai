import "server-only";

import { contentClient } from "@/lib/content/client";

export async function findSportsNewsReview(workspaceId: string, postId: string, version: number) {
  const { supabase } = await contentClient();
  const { data, error } = await supabase.from("sports_news_items").select("source_url, score, has_image")
    .eq("workspace_id", workspaceId).eq("post_id", postId).maybeSingle();
  if (error) throw new Error("sports_news_review_failed");
  if (!data || version === 1) return data;
  const revision = await supabase.from("sports_news_revision_photos").select("post_id")
    .eq("post_id", postId).eq("post_version", version).maybeSingle();
  if (revision.error) throw new Error("sports_news_review_photo_failed");
  return { ...data, has_image: revision.data !== null };
}
