import "server-only";

import { contentClient } from "@/lib/content/client";
import { ContentError, parseContentInput, toContentError } from "@/lib/content/errors";
import {
  deliveryListSchema,
  destinationListSchema,
  destinationRefSchema,
  internalDestinationSchema,
} from "@/lib/validation/publishing";
import type { PublishDeliveryRow, PublishingDestinationRow } from "@/types/database";

import type { PublishDelivery, PublishingDestination } from "./types";

/**
 * Read-only data access for publishing destinations and deliveries, always with
 * the signed-in user's Supabase client (RLS: members of the workspace only).
 * Writes happen only in the database RPCs (approval) — never here.
 */

const DESTINATION_COLUMNS = "id, workspace_id, kind, name, target_ref, status, created_at";
const DELIVERY_COLUMNS =
  "id, workspace_id, request_id, destination_id, post_id, post_version, status, attempt_count, next_attempt_at, external_post_id, last_error_code, created_at, completed_at";

type DestinationRow = Pick<
  PublishingDestinationRow,
  "id" | "workspace_id" | "kind" | "name" | "target_ref" | "status" | "created_at"
>;
type DeliveryRow = Omit<PublishDeliveryRow, "idempotency_key" | "updated_at">;

export function toDestination(row: DestinationRow): PublishingDestination {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    name: row.name,
    targetRef: row.target_ref,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toDelivery(row: DeliveryRow): PublishDelivery {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    requestId: row.request_id,
    destinationId: row.destination_id,
    postId: row.post_id,
    postVersion: row.post_version,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    externalPostId: row.external_post_id,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

type Supabase = Awaited<ReturnType<typeof contentClient>>["supabase"];

/** Destinations of a workspace: internal first, then by name. */
export async function listPublishingDestinations(input: unknown): Promise<PublishingDestination[]> {
  const { workspaceId, includeDisabled } = parseContentInput(destinationListSchema, input);
  const { supabase } = await contentClient();
  let query = supabase.from("publishing_destinations").select(DESTINATION_COLUMNS).eq("workspace_id", workspaceId);
  if (!includeDisabled) query = query.eq("status", "active");
  const { data, error } = await query.order("created_at", { ascending: true }).limit(100);
  if (error) throw toContentError(error);
  return (data ?? [])
    .map(toDestination)
    .sort((a, b) => Number(b.kind === "internal") - Number(a.kind === "internal") || a.name.localeCompare(b.name, "vi"));
}

/** One destination, or null when it does not exist or is not visible (other workspace). */
export async function getPublishingDestination(input: unknown): Promise<PublishingDestination | null> {
  const { destinationId } = parseContentInput(destinationRefSchema, input);
  const { supabase } = await contentClient();
  const { data, error } = await supabase
    .from("publishing_destinations")
    .select(DESTINATION_COLUMNS)
    .eq("id", destinationId)
    .maybeSingle();
  if (error) throw toContentError(error);
  return data ? toDestination(data) : null;
}

/** The workspace's internal destination (every workspace has exactly one). */
export async function getInternalDestination(input: unknown): Promise<PublishingDestination> {
  const { workspaceId } = parseContentInput(internalDestinationSchema, input);
  const { supabase } = await contentClient();
  return internalDestinationWith(supabase, workspaceId);
}

async function internalDestinationWith(supabase: Supabase, workspaceId: string): Promise<PublishingDestination> {
  const { data, error } = await supabase
    .from("publishing_destinations")
    .select(DESTINATION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("kind", "internal")
    .maybeSingle();
  if (error) throw toContentError(error);
  if (!data) throw new ContentError("not_found");
  return toDestination(data);
}

/**
 * Resolves the destination a publish request will target, for the post's
 * workspace, with the caller's own client:
 *   - an explicit destination must be visible, belong to that workspace (else
 *     not_found: nothing reveals other workspaces) and be active (else
 *     destination_disabled);
 *   - no destination (legacy M4 callers): explicitly the workspace's internal one.
 * The database re-checks all of this in request_post_publish.
 */
export async function resolveRequestDestination(
  supabase: Supabase,
  workspaceId: string,
  destinationId: string | undefined,
): Promise<PublishingDestination> {
  if (destinationId === undefined) return internalDestinationWith(supabase, workspaceId);
  const { data, error } = await supabase
    .from("publishing_destinations")
    .select(DESTINATION_COLUMNS)
    .eq("id", destinationId)
    .maybeSingle();
  if (error) throw toContentError(error);
  if (!data || data.workspace_id !== workspaceId) throw new ContentError("not_found");
  if (data.status !== "active") throw new ContentError("destination_disabled");
  return toDestination(data);
}

/** Execution history of a post or of a request in a workspace, newest first. */
export async function listPublishDeliveries(input: unknown): Promise<PublishDelivery[]> {
  const { workspaceId, postId, requestId, limit } = parseContentInput(deliveryListSchema, input);
  const { supabase } = await contentClient();
  let query = supabase.from("publish_deliveries").select(DELIVERY_COLUMNS).eq("workspace_id", workspaceId);
  if (postId) query = query.eq("post_id", postId);
  if (requestId) query = query.eq("request_id", requestId);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw toContentError(error);
  return (data ?? []).map(toDelivery);
}
