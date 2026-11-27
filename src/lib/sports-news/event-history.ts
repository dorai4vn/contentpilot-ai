import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";
import { buildEventIdentity, parseStoredIdentity, type KnownEvent } from "./event-identity";

export type HistoryRow = {
  source_url: string;
  event_identity: unknown;
  post_id: string | null;
  assessment: unknown;
  created_at: string;
};

const RECENT_MATERIALIZED_LIMIT = 150;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Whether a recorded item may block a later report of the same event. Only an item that became a real post
 * counts: low-score, failed, unselected or merely discovered items (post_id null) never block. A post that was
 * archived, or whose every approval request was rejected, no longer blocks either (same rule as the database's
 * contentpilot_private.sports_item_blocks_event), so a later and stronger report goes through normal review.
 */
export function blocksLaterReports(post: { archived_at: string | null } | undefined, statuses: readonly string[]): boolean {
  if (!post || post.archived_at) return false;
  return !(statuses.length > 0 && statuses.every((status) => status === "rejected"));
}

/**
 * Known, eligible events of the recent window. Stored identities are used as-is; older rows without one are
 * conservatively re-derived from their recorded headline and post body (never from guesses): an identity that is
 * not specific is ignored by the classifier, so sparse history can only fail open. Nothing is written.
 */
export async function loadBlockingEvents(
  client: SupabaseClient<Database>, workspaceId: string, rows: readonly HistoryRow[],
): Promise<KnownEvent[]> {
  const materialized = rows.filter((row) => row.post_id).slice(0, RECENT_MATERIALIZED_LIMIT);
  if (!materialized.length) return [];
  const ids = materialized.map((row) => row.post_id as string);
  const [posts, requests] = await Promise.all([
    client.from("content_posts").select("id, title, body, archived_at").eq("workspace_id", workspaceId).in("id", ids),
    client.from("content_publish_requests").select("post_id, status").eq("workspace_id", workspaceId).in("post_id", ids),
  ]);
  if (posts.error || requests.error) throw new Error("sports_news_history_failed");
  const postById = new Map(posts.data.map((post) => [post.id, post]));
  const statuses = new Map<string, string[]>();
  for (const request of requests.data) statuses.set(request.post_id, [...(statuses.get(request.post_id) ?? []), request.status]);

  return materialized.flatMap<KnownEvent>((row) => {
    const post = postById.get(row.post_id as string);
    if (!blocksLaterReports(post, statuses.get(row.post_id as string) ?? [])) return [];
    const assessment = object(row.assessment);
    const title = typeof assessment.title === "string" ? assessment.title : post?.title;
    const stored = parseStoredIdentity(row.event_identity);
    if (stored) return [{ identity: stored, sourceUrl: row.source_url, title, origin: "stored" as const }];
    if (!title) return [];
    const published = typeof assessment.publishedAt === "string" ? Date.parse(assessment.publishedAt) : NaN;
    const identity = buildEventIdentity({
      title, summary: (post?.body ?? "").slice(0, 1200), publishedAt: Number.isFinite(published) ? published : Date.parse(row.created_at),
    });
    return [{ identity, sourceUrl: row.source_url, title, origin: "derived" as const }];
  });
}
