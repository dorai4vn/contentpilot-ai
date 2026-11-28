import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getPublisher } from "@/lib/publishing/registry";
import { PublisherSecret } from "@/lib/publishing/types";
import { readSportsPhoto } from "./photo-snapshot";
import { publishedToday } from "./publication-day";
import { assertAutomationNotOff, readAutomationMode } from "./automation-mode";
import { permitsTemporaryAutoPublish } from "./temporary-auto-publish";

type Client = SupabaseClient<Database>;
type Destination = { workspaceId: string; projectId: string; destinationId: string };

function argsFor(target: Destination) {
  return { p_workspace_id: target.workspaceId, p_project_id: target.projectId, p_destination_id: target.destinationId };
}

export async function getTemporaryAutoWindow(client: Client, target: Destination) {
  const { data, error } = await client.rpc("get_sports_auto_publish_window", argsFor(target));
  if (error) throw new Error("sports_auto_window_read_failed");
  return data[0] ?? null;
}

export async function sendTemporarySportsPost(client: Client, target: Destination, token: string, post: {
  id: string; title: string; body: string; publishedAt: number;
}) {
  // Prepare bytes before reserving the send so a failed crop can still go through human review.
  await assertAutomationNotOff(client, target.workspaceId, target.projectId);
  const image = await readSportsPhoto(client, post.id, 1);
  if (!image) return false;
  const { data, error } = await client.rpc("claim_sports_auto_publish", {
    ...argsFor(target), p_post_id: post.id,
  });
  if (error) throw new Error("sports_auto_claim_failed");
  const lease = data[0];
  if (!lease) return false;

  const now = Date.now();
  const window = { ...target, startsAt: lease.starts_at, endsAt: lease.ends_at, persistent: lease.persistent };
  const allowed = permitsTemporaryAutoPublish(window, {
    ...target, kind: "telegram", source: "rss", createdAt: Date.parse(lease.created_at),
    publishedAt: post.publishedAt, testMode: false,
  }, now) && publishedToday(post.publishedAt, now) && (lease.ends_at === null || now + 15_000 < Date.parse(lease.ends_at));

  // Final checkpoint before the external call. The lease is already reserved, so an Off switch here is
  // reported as an unsent, failed outcome (never a duplicate-able send).
  const off = allowed && await readAutomationMode(client, target.workspaceId, target.projectId) === "off";
  const publisher = getPublisher("telegram");
  const result = allowed && !off ? await publisher.publish(publisher.render({
    postId: post.id, postVersion: 1, title: post.title, body: post.body, image,
  }), {
    targetRef: lease.target_ref, credentials: new PublisherSecret(token), idempotencyKey: `rss-auto:${lease.id}`,
  }) : { ok: false as const, code: off ? "automation_off" : "window_expired" };

  const finish = await client.rpc("finish_sports_auto_publish", {
    p_workspace_id: target.workspaceId, p_id: lease.id,
    p_external_id: result.ok ? result.externalId : null, p_error_code: result.ok ? null : result.code,
  });
  if (finish.error || !finish.data) throw new Error("sports_auto_finish_failed");
  return result.ok;
}
