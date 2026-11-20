import "server-only";

import { z } from "zod";

import { uuidSchema } from "@/lib/validation/content";
import {
  publishApproveSchema,
  publishRejectSchema,
  publishRequestCreateSchema,
  publishRequestListSchema,
  publishRequestRefSchema,
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

import { contentClient } from "./client";
import { ContentError, parseContentInput, toContentError } from "./errors";

/**
 * M4 publish approval: data layer over the RPCs of
 * supabase/migrations/20261120200000_publish_approval.sql.
 *
 *   request_post_publish(p_post_id, p_expected_version, p_source, p_agent_turn_id, p_reason)
 *   approve_publish_request(p_request_id, p_expected_post_version)  -> content_posts
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
  "id, workspace_id, post_id, post_version, status, request_source, agent_turn_id, reason, requested_by, requested_at, expires_at, decided_by, decided_at, decision_note, cancel_reason";
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

function toPublishedPost(row: ContentPostRow): PublishedPost {
  if (row.status !== "published" || row.published_at === null) throw new ContentError("unknown");
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    title: row.title,
    status: "published",
    version: row.version,
    publishedAt: row.published_at,
    updatedBy: row.updated_by,
  };
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
 * Asks for the post to be published at exactly `expectedVersion` (any member).
 * Errors: version_conflict, request_pending_exists, post_published, archived,
 * not_found.
 */
export async function requestPostPublish(input: unknown, options?: PublishRequestOptions): Promise<PublishRequest> {
  const { source, agentTurnId, workspaceId } = parseRequestOptions(options);
  const { postId, expectedVersion, reason } = parseContentInput(publishRequestCreateSchema, input);
  const { supabase } = await contentClient();

  if (workspaceId !== undefined) {
    const { data: post, error } = await supabase
      .from("content_posts")
      .select("id, workspace_id")
      .eq("id", postId)
      .maybeSingle();
    if (error) throw toContentError(error);
    if (!post || post.workspace_id !== workspaceId) throw new ContentError("not_found");
  }

  const { data, error } = await supabase.rpc("request_post_publish", {
    p_post_id: postId,
    p_expected_version: expectedVersion,
    p_source: source,
    p_agent_turn_id: agentTurnId ?? null,
    p_reason: reason,
  });
  // Two concurrent requests for the same post: the loser hits the unique
  // "one pending request per post" index.
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    throw new ContentError("request_pending_exists");
  }
  return requestResult(data, error);
}

/**
 * Approves a pending request and publishes the post in one database transaction
 * (owners/admins of the request's workspace). `expectedPostVersion` is the post
 * version the approver was shown. Errors: forbidden, request_closed,
 * request_expired, version_conflict, archived, post_published, not_found.
 */
export async function approvePublishRequest(input: unknown): Promise<PublishedPost> {
  const { requestId, expectedPostVersion } = parseContentInput(publishApproveSchema, input);
  const { supabase, user } = await contentClient();

  const { request, role } = await loadRequestForDecision(supabase, user.id, requestId);
  if (!MANAGER_ROLES.includes(role)) throw new ContentError("forbidden");
  assertDecidable(request);
  if (request.post_version !== expectedPostVersion) throw new ContentError("version_conflict");

  const { data, error } = await supabase.rpc("approve_publish_request", {
    p_request_id: requestId,
    p_expected_post_version: expectedPostVersion,
  });
  if (error) throw toContentError(error);
  if (!data) throw new ContentError("unknown");
  return toPublishedPost(data);
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
