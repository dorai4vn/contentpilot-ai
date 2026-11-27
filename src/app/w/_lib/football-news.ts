import "server-only";

import { createClient } from "@/lib/supabase/server";

export async function recentFootballNews(workspaceId: string, limit: number) {
  const client = await createClient();
  const { data, error } = await client.from("sports_news_items")
    .select("source_url,score,has_image,assessment,created_at,post_id")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("football_news_read_failed");
  return data.map((item) => {
    const assessment = item.assessment && typeof item.assessment === "object" && !Array.isArray(item.assessment)
      ? item.assessment : {};
    return {
      ...item,
      title: typeof assessment.title === "string" ? assessment.title : item.source_url,
    };
  });
}
