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

/** Recent semantic-dedup decisions (skipped duplicates and follow-ups) with their structured evidence. RLS applies. */
export async function recentEventDecisions(workspaceId: string, limit: number) {
  const client = await createClient();
  const { data, error } = await client.from("sports_news_event_matches")
    .select("source_url,decision,reasons,evidence,created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("football_event_decisions_read_failed");
  return data.map((row) => {
    const reasons = Array.isArray(row.reasons) ? row.reasons : [];
    const evidence = row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence) ? row.evidence : {};
    return {
      source_url: row.source_url,
      decision: row.decision,
      created_at: row.created_at,
      reasons: reasons.flatMap((reason) => reason && typeof reason === "object" && !Array.isArray(reason) && typeof reason.code === "string"
        ? [{ code: reason.code, detail: typeof reason.detail === "string" ? reason.detail : null }] : []),
      matchedSourceUrl: typeof evidence.matchedSourceUrl === "string" ? evidence.matchedSourceUrl : null,
      matchedTitle: typeof evidence.matchedTitle === "string" ? evidence.matchedTitle : null,
    };
  });
}
