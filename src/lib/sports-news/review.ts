import "server-only";

import { contentClient } from "@/lib/content/client";

export async function findSportsNewsReview(workspaceId: string, postId: string) {
  const { supabase } = await contentClient();
  const { data, error } = await supabase.from("sports_news_items").select("source_url, score")
    .eq("workspace_id", workspaceId).eq("post_id", postId).maybeSingle();
  if (error) throw new Error("sports_news_review_failed");
  return data;
}
