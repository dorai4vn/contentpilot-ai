import "server-only";

import { z } from "zod";

import { uuidSchema } from "@/lib/validation/content";
import {
  publishApproveSchema,
  publishRejectSchema,
  publishRequestCountSchema,
  publishRequestCreateSchema,
  publishRequestListSchema,
  publishRequestPageSchema,
  publishRequestRefSchema,
  type PublishQueueFilter,
} from "@/lib/validation/publish";
import type {
  ContentChangeSource,
  ContentPostRow,
  ContentPublishRequestRow,
  PublishRequestCancelReason,
  PublishRequestEvent,
  PublishRequestStatus,
  WorkspaceRole,
} from "@/types/database";

import { resolveRequestDestination } from "@/lib/publishing/destinations";

import { contentClient } from "./client";
import { ContentError, parseContentInput, toContentError } from "./errors";

/**
 * M4 publish approval: data layer over the RPCs of
 * supabase/migrations/20261120200000_publish_approval.sql.
 *
 *   request_post_publish(p_post_id, p_expected_version, p_source, p_agent_turn_id, p_reason,
 *                        p_destination_id)                               (M4.6a)
 *   approve_publish_request(p_request_id, p_expected_post_version,
 *                           p_expected_destination_id)  -> content_posts (M4.6a)
 *   reject_publish_request(p_request_id, p_note)                    -> content_publish_requests
 *   cancel_publish_request(p_request_id)                            -> content_publish_requests
 *
 * Always the signed-in user's Supabase client (RLS applies), never the
 * service-role key. The database is the authority: it sets requested_by /
 * decided_by / timestamps from auth.uid() / now(), checks the owner/admin role on
 * the request's own workspace, the post version, the request state and expiry,
 * and refuses approvals that carry the agent marker header.
 *
 * The checks done here before calling an RPC (request visible, caller's role read
 * from workspace_members, pending, not expired, version) only give clearer errors
 * and avoid pointless calls. They never replace the database checks, and nothing
 * the client sends can influence them: user input is limited to ids, the
 * expected version and free text, validated by strict schemas.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status for display: a pending request past expires_at is shown as expired. */
export type PublishRequestDisplayStatus = PublishRequestStatus | "expired";

export type PublishRequest = {
  id: string;
  workspaceId: string;
  postId: string;
  /** The one destination this request (and its approval) is for. */
  destinationId: string;
  postVersion: number;
  status: PublishRequestStatus;
  displayStatus: PublishRequestDisplayStatus;
  requestSource: ContentChangeSource;
  agentTurnId: string | null;
  reason: string | null;
  requestedBy: string | null;
  requestedAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  cancelReason: PublishRequestCancelReason | null;
};

export type PublishRequestAuditEvent = {
  id: string;
  requestId: string;
  postId: string;
  postVersion: number;
  event: PublishRequestEvent;
  cancelReason: PublishRequestCancelReason | null;
  actorId: string | null;
  actorSource: ContentChangeSource | null;
  createdAt: string;
};

export type PublishRequestDetail = { request: PublishRequest; events: PublishRequestAuditEvent[] };

/** The post as returned by approve_publish_request (now published). */
export type PublishedPost = {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  status: "published";
  version: number;
  publishedAt: string;
  updatedBy: string | null;
};

export type ApprovedPost = PublishedPost | (
  Omit<PublishedPost, "status" | "publishedAt"> & { status: "draft" | "ready"; publishedAt: null }
);

type EventRow = {
  id: string;
  request_id: string;
  post_id: string;
  post_version: number;
  event: PublishRequestEvent;
  cancel_reason: PublishRequestCancelReason | null;
  actor_id: string | null;
  actor_source: ContentChangeSource | null;
  created_at: string;
};

const REQUEST_COLUMNS =
  "id, workspace_id, post_id, destination_id, post_version, status, request_source, agent_turn_id, reason, requested_by, requested_at, expires_at, decided_by, decided_at, decision_note, cancel_reason";
const EVENT_COLUMNS = "id, request_id, post_id, post_version, event, cancel_reason, actor_id, actor_source, created_at";

function isExpired(row: Pick<ContentPublishRequestRow, "expires_at">, now = Date.now()): boolean {
  const expiresAt = Date.parse(row.expires_at);
  return Number.isNaN(expiresAt) || expiresAt <= now;
}

function toRequest(row: ContentPublishRequestRow): PublishRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    postId: row.post_id,
    destinationId: row.destination_id,
    postVersion: row.post_version,
    status: row.status,
    displayStatus: row.status === "pending" && isExpired(row) ? "expired" : row.status,
    requestSource: row.request_source,
    agentTurnId: row.agent_turn_id,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    cancelReason: row.cancel_reason,
  };
}

function toEvent(row: EventRow): PublishRequestAuditEvent {
  return {
    id: row.id,
    requestId: row.request_id,
    postId: row.post_id,
    postVersion: row.post_version,
    event: row.event,
    cancelReason: row.cancel_reason,
    actorId: row.actor_id,
    actorSource: row.actor_source,
    createdAt: row.created_at,
  };
}

function toApprovedPost(row: ContentPostRow, expectedVersion: number): ApprovedPost {
  const post = {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    title: row.title,
    version: row.version,
    updatedBy: row.updated_by,
  };
  if (row.status === "published" && row.published_at !== null) {
    return { ...post, status: "published", publishedAt: row.published_at };
  }
  if ((row.status === "draft" || row.status === "ready") &&
      row.published_at === null && row.version === expectedVersion) {
    return { ...post, status: row.status, publishedAt: null };
  }
  throw new ContentError("unknown");
}

function requestResult(data: ContentPublishRequestRow | null, error: unknown): PublishRequest {
  if (error) throw toContentError(error);
  if (!data) throw new ContentError("unknown");
  return toRequest(data);
}

// ---------------------------------------------------------------------------
// Internal options (trusted server code only, never user input)
// ---------------------------------------------------------------------------

/**
 * Set by trusted server code as a separate argument, never taken from a form or
 * request body. Server Actions pass nothing (source "user"). Only the agent
 * executor (M4.6) will pass { source: "agent", agentTurnId, workspaceId }.
 */
export type PublishRequestOptions = {
  source?: ContentChangeSource;
  agentTurnId?: string;
  /** The post must belong to this workspace (else not_found, nothing written). */
  workspaceId?: string;
};

const requestOptionsSchema = z
  .strictObject({
    source: z.enum(["user", "agent"]).optional().default("user"),
    agentTurnId: uuidSchema.optional(),
    workspaceId: uuidSchema.optional(),
  })
  .refine((o) => (o.source === "agent") === (o.agentTurnId !== undefined));

function parseRequestOptions(options: PublishRequestOptions | undefined) {
  const parsed = requestOptionsSchema.safeParse(options ?? {});
  if (!parsed.success) throw new ContentError("invalid_input");
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Pre-checks
// ---------------------------------------------------------------------------

type Supabase = Awaited<ReturnType<typeof contentClient>>["supabase"];

const MANAGER_ROLES: readonly WorkspaceRole[] = ["owner", "admin"];

/**
 * Loads the request (RLS: only members of its workspace see it) and the caller's
 * role in THAT workspace, read from workspace_members for the session user.
 */
async function loadRequestForDecision(supabase: Supabase, userId: string, requestId: string) {
  const { data: request, error } = await supabase
    .from("content_publish_requests")
    .select(REQUEST_COLUMNS)
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw toContentError(error);
  if (!request) throw new ContentError("not_found");

  const { data: membership, error: roleError } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", request.workspace_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (roleError) throw toContentError(roleError);
  if (!membership) throw new ContentError("not_found");

  return { request, role: membership.role as WorkspaceRole };
}

/** Pending and not expired, else the matching error (approve / reject). */
function assertDecidable(request: ContentPublishRequestRow): void {
  if (request.status !== "pending") throw new ContentError("request_closed");
  if (isExpired(request)) throw new ContentError("request_expired");
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Asks for the post to be published at exactly `expectedVersion` on ONE
 * destination (any member). The destination is always passed to the database
 * explicitly: the given one (active, same workspace as the post), or — legacy M4
 * callers that send none — the workspace's internal destination, resolved here.
 * The agent must always name it. Errors: version_conflict,
 * request_pending_exists, post_published, archived, destination_disabled,
 * not_found.
 */
export async function requestPostPublish(input: unknown, options?: PublishRequestOptions): Promise<PublishRequest> {
  const { source, agentTurnId, workspaceId } = parseRequestOptions(options);
  const { postId, expectedVersion, reason, destinationId } = parseContentInput(publishRequestCreateSchema, input);
  if (source === "agent" && destinationId === undefined) {
    throw new ContentError("invalid_input", { destinationId: "Cần chọn đích xuất bản." });
  }
  const { supabase } = await contentClient();

  // The post decides the workspace (never the input); RLS hides other workspaces.
  const { data: post, error: postError } = await supabase
    .from("content_posts")
    .select("id, workspace_id")
    .eq("id", postId)
    .maybeSingle();
  if (postError) throw toContentError(postError);
  if (!post || (workspaceId !== undefined && post.workspace_id !== workspaceId)) throw new ContentError("not_found");
  const destination = await resolveRequestDestination(supabase, post.workspace_id, destinationId);

  const { data, error } = await supabase.rpc("request_post_publish", {
    p_post_id: postId,
    p_expected_version: expectedVersion,
    p_source: source,
    p_agent_turn_id: agentTurnId ?? null,
    p_reason: reason,
    p_destination_id: destination.id,
  });
  // Two concurrent requests for the same post and destination: the loser hits
  // the unique "one pending request per (post, destination)" index.
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    throw new ContentError("request_pending_exists");
  }
  return requestResult(data, error);
}

/**
 * Approves a pending request for exactly its destination (owners/admins of the
 * request's workspace). For the internal destination the post is published in
 * the same database transaction. `expectedPostVersion` and
 * `expectedDestinationId` are what the approver was shown; the destination is
 * always sent to the database explicitly (the stored one when a legacy caller
 * omits it). Errors: forbidden, request_closed, request_expired,
 * version_conflict, destination_mismatch, destination_disabled, archived,
 * post_published, not_found.
 */
export async function approvePublishRequest(input: unknown): Promise<ApprovedPost> {
  const { requestId, expectedPostVersion, expectedDestinationId } = parseContentInput(publishApproveSchema, input);
  const { supabase, user } = await contentClient();

  const { request, role } = await loadRequestForDecision(supabase, user.id, requestId);
  if (!MANAGER_ROLES.includes(role)) throw new ContentError("forbidden");
  assertDecidable(request);
  if (request.post_version !== expectedPostVersion) throw new ContentError("version_conflict");
  if (expectedDestinationId !== undefined && expectedDestinationId !== request.destination_id) {
    throw new ContentError("destination_mismatch");
  }

  const { data, error } = await supabase.rpc("approve_publish_request", {
    p_request_id: requestId,
    p_expected_post_version: expectedPostVersion,
    p_expected_destination_id: expectedDestinationId ?? request.destination_id,
  });
  if (error) throw toContentError(error);
  if (!data) throw new ContentError("unknown");
  return toApprovedPost(data, expectedPostVersion);
}

/** Rejects a pending request (owners/admins); the post is not changed. */
export async function rejectPublishRequest(input: unknown): Promise<PublishRequest> {
  const { requestId, note } = parseContentInput(publishRejectSchema, input);
  const { supabase, user } = await contentClient();

  const { request, role } = await loadRequestForDecision(supabase, user.id, requestId);
  if (!MANAGER_ROLES.includes(role)) throw new ContentError("forbidden");
  assertDecidable(request);

  const { data, error } = await supabase.rpc("reject_publish_request", { p_request_id: requestId, p_note: note });
  return requestResult(data, error);
}

/**
 * Withdraws a pending request: its requester or an owner/admin. Also closes an
 * expired request (recorded by the database as cancel_reason "expired").
 */
export async function cancelPublishRequest(input: unknown): Promise<PublishRequest> {
  const { requestId } = parseContentInput(publishRequestRefSchema, input);
  const { supabase, user } = await contentClient();

  const { request, role } = await loadRequestForDecision(supabase, user.id, requestId);
  if (request.requested_by !== user.id && !MANAGER_ROLES.includes(role)) throw new ContentError("forbidden");
  if (request.status !== "pending") throw new ContentError("request_closed");

  const { data, error } = await supabase.rpc("cancel_publish_request", { p_request_id: requestId });
  return requestResult(data, error);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Requests of a workspace (optionally of one post / one status), newest first. */
export async function listPublishRequests(input: unknown): Promise<PublishRequest[]> {
  const { workspaceId, postId, status, limit } = parseContentInput(publishRequestListSchema, input);
  const { supabase } = await contentClient();

  let query = supabase.from("content_publish_requests").select(REQUEST_COLUMNS).eq("workspace_id", workspaceId);
  if (postId) query = query.eq("post_id", postId);
  if (status) query = query.eq("status", status);
  const { data, error } = await query.order("requested_at", { ascending: false }).limit(limit);

  if (error) throw toContentError(error);
  return (data ?? []).map(toRequest);
}

/** One request with its audit trail (oldest event first), or null when not visible. */
export async function getPublishRequest(input: unknown): Promise<PublishRequestDetail | null> {
  const { requestId } = parseContentInput(publishRequestRefSchema, input);
  const { supabase } = await contentClient();

  const { data: request, error } = await supabase
    .from("content_publish_requests")
    .select(REQUEST_COLUMNS)
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw toContentError(error);
  if (!request) return null;

  const { data: events, error: eventsError } = await supabase
    .from("content_publish_request_events")
    .select(EVENT_COLUMNS)
    .eq("request_id", request.id)
    .eq("workspace_id", request.workspace_id)
    .order("created_at", { ascending: true })
    // Same-transaction events (approved + published) in lifecycle order (enum order).
    .order("event", { ascending: true })
    .limit(50);
  if (eventsError) throw toContentError(eventsError);

  return { request: toRequest(request), events: (events ?? []).map(toEvent) };
}

// ---------------------------------------------------------------------------
// Approval queue: server-side pagination and exact counts
// ---------------------------------------------------------------------------

export type PublishRequestPage = {
  items: PublishRequest[];
  filter: PublishQueueFilter;
  page: number;
  pageSize: number;
  /** Exact number of requests matching the filter (all pages). */
  total: number;
  totalPages: number;
};

export type PublishRequestCounts = Record<PublishQueueFilter, number>;

/** The filter methods withFilter needs (structural, so it works for any select). */
interface Filterable<Q> {
  eq(column: string, value: string): Q;
  gt(column: string, value: string): Q;
  lte(column: string, value: string): Q;
}

/**
 * Applies a display filter in the database. "pending" means still decidable
 * (expires_at in the future); "expired" means pending past expires_at — the same
 * rule as displayStatus and as the RPCs (expires_at <= now() is expired).
 */
function withFilter<Q extends Filterable<Q>>(query: Q, filter: PublishQueueFilter, nowIso: string): Q {
  switch (filter) {
    case "all":
      return query;
    case "pending":
      return query.eq("status", "pending").gt("expires_at", nowIso);
    case "expired":
      return query.eq("status", "pending").lte("expires_at", nowIso);
    default:
      return query.eq("status", filter);
  }
}

/**
 * One page of a workspace's requests for a display filter, newest first.
 * Order is stable across pages: requested_at desc, then id desc (tie-breaker),
 * so no row is skipped or repeated between pages of an unchanged list.
 */
export async function listPublishRequestsPage(input: unknown): Promise<PublishRequestPage> {
  const { workspaceId, filter, page, pageSize } = parseContentInput(publishRequestPageSchema, input);
  const { supabase } = await contentClient();
  const from = (page - 1) * pageSize;

  const nowIso = new Date().toISOString();

  const base = supabase
    .from("content_publish_requests")
    .select(REQUEST_COLUMNS, { count: "exact" })
    .eq("workspace_id", workspaceId);
  const { data, error, count } = await withFilter(base, filter, nowIso)
    .order("requested_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + pageSize - 1);

  let total = count ?? 0;
  if (error && isRangeNotSatisfiable(error)) {
    // A page past the end (e.g. ?page=99): PostgREST answers 416 / PGRST103.
    // Return an empty page with the exact total instead of an error.
    const counted = await withFilter(
      supabase.from("content_publish_requests").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
      filter,
      nowIso,
    );
    if (counted.error) throw toContentError(counted.error);
    total = counted.count ?? 0;
  } else if (error) {
    throw toContentError(error);
  }
  return {
    items: error ? [] : (data ?? []).map(toRequest),
    filter,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function isRangeNotSatisfiable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "PGRST103";
}

const COUNTED_FILTERS = ["pending", "expired", "approved", "rejected", "cancelled"] as const;

/** Exact number of requests per display filter in a workspace (no rows transferred). */
export async function countPublishRequests(input: unknown): Promise<PublishRequestCounts> {
  const { workspaceId } = parseContentInput(publishRequestCountSchema, input);
  const { supabase } = await contentClient();
  const nowIso = new Date().toISOString();

  const results = await Promise.all(
    COUNTED_FILTERS.map(async (filter) => {
      const base = supabase
        .from("content_publish_requests")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId);
      const { error, count } = await withFilter(base, filter, nowIso);
      if (error) throw toContentError(error);
      return [filter, count ?? 0] as const;
    }),
  );
  const counts = Object.fromEntries(results) as Omit<PublishRequestCounts, "all">;
  return { ...counts, all: COUNTED_FILTERS.reduce((sum, f) => sum + counts[f], 0) };
}
