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

export type PostState = { status?: string | null; archived_at: string | null };
const IN_FLIGHT_OR_DONE_DELIVERY = new Set(["queued", "sending", "succeeded"]);

/**
 * Whether a recorded item may block a later report of the same event. Only an item that became a real post
 * counts: low-score, failed, unselected or merely discovered items (post_id null) never block.
 *  - A post that was published, or has a queued/sending/succeeded delivery, ALWAYS blocks, even if archived later.
 *  - Otherwise it blocks while it is not archived and not rejected (every approval request rejected); an
 *    archived/rejected post that was never sent may be reconsidered (the new post is manual-review only).
 * Same rule as contentpilot_private.sports_item_blocks_event. The temporary auto-publish ledger is private to the
 * database, so for that one case the database recheck (not this pre-filter) is the authority.
 */
export function blocksLaterReports(
  post: PostState | undefined, statuses: readonly string[], deliveries: readonly string[] = [],
): boolean {
  if (!post) return false;
  if (post.status === "published" || deliveries.some((status) => IN_FLIGHT_OR_DONE_DELIVERY.has(status))) return true;
  if (post.archived_at) return false;
  return !(statuses.length > 0 && statuses.every((status) => status === "rejected"));
}

export type EventHistory = {
  /** Events that became posts and still block later reports. */
  blocking: KnownEvent[];
  /** Events whose post was archived/rejected without being sent: a later report is allowed but manual-review only. */
  reconsidered: KnownEvent[];
};

/**
 * Known, eligible events of the recent window. Stored identities are used as-is; older rows without one are
 * conservatively re-derived from their recorded headline and post body (never from guesses): an identity that is
 * not specific is ignored by the classifier, so sparse history can only fail open. Nothing is written.
 */
export async function loadEventHistory(
  client: SupabaseClient<Database>, workspaceId: string, rows: readonly HistoryRow[],
): Promise<EventHistory> {
  const materialized = rows.filter((row) => row.post_id).slice(0, RECENT_MATERIALIZED_LIMIT);
  if (!materialized.length) return { blocking: [], reconsidered: [] };
  const ids = materialized.map((row) => row.post_id as string);
  const [posts, requests, deliveries] = await Promise.all([
    client.from("content_posts").select("id, title, body, status, archived_at").eq("workspace_id", workspaceId).in("id", ids),
    client.from("content_publish_requests").select("post_id, status").eq("workspace_id", workspaceId).in("post_id", ids),
    client.from("publish_deliveries").select("post_id, status").eq("workspace_id", workspaceId).in("post_id", ids),
  ]);
  if (posts.error || requests.error || deliveries.error) throw new Error("sports_news_history_failed");
  const deliveryStatuses = new Map<string, string[]>();
  for (const delivery of deliveries.data) deliveryStatuses.set(delivery.post_id, [...(deliveryStatuses.get(delivery.post_id) ?? []), delivery.status]);
  const postById = new Map(posts.data.map((post) => [post.id, post]));
  const statuses = new Map<string, string[]>();
  for (const request of requests.data) statuses.set(request.post_id, [...(statuses.get(request.post_id) ?? []), request.status]);

  const blocking: KnownEvent[] = [];
  const reconsidered: KnownEvent[] = [];
  for (const row of materialized) {
    const post = postById.get(row.post_id as string);
    if (!post) continue;
    const blocks = blocksLaterReports(post, statuses.get(post.id) ?? [], deliveryStatuses.get(post.id) ?? []);
    const event = knownEventOf(row, post);
    if (event) (blocks ? blocking : reconsidered).push(event);
  }
  return { blocking, reconsidered };
}

function knownEventOf(row: HistoryRow, post: { title: string; body: string }): KnownEvent | null {
  const assessment = object(row.assessment);
  const title = typeof assessment.title === "string" ? assessment.title : post.title;
  const stored = parseStoredIdentity(row.event_identity);
  if (stored) return { identity: stored, sourceUrl: row.source_url, title, origin: "stored" };
  if (!title) return null;
  const published = typeof assessment.publishedAt === "string" ? Date.parse(assessment.publishedAt) : NaN;
  const identity = buildEventIdentity({
    title, summary: post.body.slice(0, 1200), publishedAt: Number.isFinite(published) ? published : Date.parse(row.created_at),
  });
  return { identity, sourceUrl: row.source_url, title, origin: "derived" };
}
