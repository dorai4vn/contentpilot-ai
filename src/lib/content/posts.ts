import "server-only";

import { z } from "zod";

import {
  postCreateSchema,
  postListSchema,
  postPatchSchema,
  postRefSchema,
  postStatusChangeSchema,
  postUpdateSchema,
  postVersionRefSchema,
} from "@/lib/validation/content";
import type { ContentChangeSource, ContentPostRow, ContentPostStatus } from "@/types/database";

import { contentClient } from "./client";
import { ContentError, parseContentInput, toContentError } from "./errors";

/**
 * Content posts. Reads and inserts go through RLS as the signed-in user. Every
 * change to an existing post goes through the database RPCs, which require the
 * version the user is looking at (optimistic locking) and record history in the
 * same transaction. There is no publish and no delete function.
 */

/**
 * Internal write options. They are a separate argument, never part of the
 * user-supplied input (which is validated by strict schemas that reject an
 * unknown `changeSource` key), so a form or request body cannot set them.
 * Server Actions pass nothing: changes are recorded as "user". Only the M3 agent
 * executor passes { changeSource: "agent" }.
 */
export type ContentWriteOptions = { changeSource?: ContentChangeSource };

const changeSourceSchema = z.enum(["user", "agent"]);

/** Resolves the change source; anything other than "user" / "agent" is rejected. */
function changeSourceOf(options: ContentWriteOptions | undefined): ContentChangeSource {
  const value = options?.changeSource === undefined ? "user" : options.changeSource;
  const parsed = changeSourceSchema.safeParse(value);
  if (!parsed.success) throw new ContentError("invalid_input");
  return parsed.data;
}

const POST_SUMMARY_COLUMNS =
  "id, workspace_id, project_id, title, status, scheduled_for, version, last_change_source, archived_at, created_at, updated_at";
const POST_COLUMNS = `${POST_SUMMARY_COLUMNS}, body, created_by, updated_by` as const;
const VERSION_COLUMNS =
  "id, post_id, version, title, body, status, scheduled_for, archived_at, changed_by, change_source, created_at";

export type ContentPostSummary = {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  status: ContentPostStatus;
  scheduledFor: string | null;
  version: number;
  lastChangeSource: ContentChangeSource;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContentPost = ContentPostSummary & {
  body: string;
  createdBy: string | null;
  updatedBy: string | null;
};

export type ContentPostVersion = {
  id: string;
  postId: string;
  version: number;
  title: string;
  body: string;
  status: ContentPostStatus;
  scheduledFor: string | null;
  archivedAt: string | null;
  changedBy: string | null;
  changeSource: ContentChangeSource;
  createdAt: string;
};

type SummaryRow = Omit<ContentPostRow, "body" | "created_by" | "updated_by" | "published_at">;
type PostRow = Omit<ContentPostRow, "published_at">;
type VersionRow = {
  id: string;
  post_id: string;
  version: number;
  title: string;
  body: string;
  status: ContentPostStatus;
  scheduled_for: string | null;
  archived_at: string | null;
  changed_by: string | null;
  change_source: ContentChangeSource;
  created_at: string;
};

function toSummary(row: SummaryRow): ContentPostSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    scheduledFor: row.scheduled_for,
    version: row.version,
    lastChangeSource: row.last_change_source,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPost(row: PostRow): ContentPost {
  return { ...toSummary(row), body: row.body, createdBy: row.created_by, updatedBy: row.updated_by };
}

function toVersion(row: VersionRow): ContentPostVersion {
  return {
    id: row.id,
    postId: row.post_id,
    version: row.version,
    title: row.title,
    body: row.body,
    status: row.status,
    scheduledFor: row.scheduled_for,
    archivedAt: row.archived_at,
    changedBy: row.changed_by,
    changeSource: row.change_source,
    createdAt: row.created_at,
  };
}

/** Posts of a project, most recently updated first (without bodies). */
export async function listPosts(input: unknown): Promise<ContentPostSummary[]> {
  const { projectId, status, includeArchived } = parseContentInput(postListSchema, input);
  const { supabase } = await contentClient();

  let query = supabase.from("content_posts").select(POST_SUMMARY_COLUMNS).eq("project_id", projectId);
  if (status) query = query.eq("status", status);
  if (!includeArchived) query = query.is("archived_at", null);
  const { data, error } = await query.order("updated_at", { ascending: false }).limit(200);

  if (error) throw toContentError(error);
  return (data ?? []).map(toSummary);
}

/** One post with its body, or null when it does not exist or is not visible. */
export async function getPost(input: unknown): Promise<ContentPost | null> {
  const { postId } = parseContentInput(postRefSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase.from("content_posts").select(POST_COLUMNS).eq("id", postId).maybeSingle();

  if (error) throw toContentError(error);
  return data ? toPost(data) : null;
}

/** Version history of a post, newest first (empty when not visible). */
export async function getPostHistory(input: unknown): Promise<ContentPostVersion[]> {
  const { postId } = parseContentInput(postRefSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase
    .from("content_post_versions")
    .select(VERSION_COLUMNS)
    .eq("post_id", postId)
    .order("version", { ascending: false })
    .limit(100);

  if (error) throw toContentError(error);
  return (data ?? []).map(toVersion);
}

/** Creates a post in an active project (any workspace member, enforced by RLS). */
export async function createPost(input: unknown, options?: ContentWriteOptions): Promise<ContentPost> {
  const changeSource = changeSourceOf(options);
  const { workspaceId, projectId, title, body, status, scheduledFor } = parseContentInput(postCreateSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase
    .from("content_posts")
    .insert({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      project_id: projectId,
      title,
      body,
      status,
      scheduled_for: scheduledFor,
      last_change_source: changeSource,
    })
    .select(POST_COLUMNS)
    .single();

  if (error) throw toContentError(error);
  return toPost(data);
}

function rpcResult(data: ContentPostRow | null, error: unknown): ContentPost {
  if (error) throw toContentError(error);
  if (!data) throw new ContentError("unknown");
  return toPost(data);
}

/**
 * Replaces the editable fields of a post. Fails with "version_conflict" when the
 * post changed after the user loaded `expectedVersion`: nothing is overwritten.
 */
export async function updatePost(input: unknown, options?: ContentWriteOptions): Promise<ContentPost> {
  const changeSource = changeSourceOf(options);
  const { postId, expectedVersion, title, body, status, scheduledFor } = parseContentInput(postUpdateSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase.rpc("update_content_post", {
    p_post_id: postId,
    p_expected_version: expectedVersion,
    p_title: title,
    p_body: body,
    p_status: status,
    p_scheduled_for: scheduledFor,
    p_change_source: changeSource,
  });
  return rpcResult(data, error);
}

/**
 * Switches a post between draft and ready WITHOUT touching anything else.
 *
 * The update RPC replaces title, body, status and scheduled_for together, so the
 * other three are sent back exactly as the database returned them: raw strings,
 * not re-validated or normalised (re-validating would trim the title and cut
 * scheduled_for to milliseconds, silently changing the post). Safety still comes
 * from the database: the RPC checks `expectedVersion` from the caller, so if the
 * post changed after it was read here, the call fails with version_conflict
 * instead of writing the stale values back. RLS and history behave as for any update.
 */
export async function setPostStatus(input: unknown, options?: ContentWriteOptions): Promise<ContentPost> {
  const changeSource = changeSourceOf(options);
  const { postId, expectedVersion, status } = parseContentInput(postStatusChangeSchema, input);
  const { supabase } = await contentClient();

  const { data: current, error: readError } = await supabase
    .from("content_posts")
    .select(POST_COLUMNS)
    .eq("id", postId)
    .maybeSingle();
  if (readError) throw toContentError(readError);
  if (!current) throw new ContentError("not_found");
  if (current.version !== expectedVersion) throw new ContentError("version_conflict");
  if (current.status === status) return toPost(current);

  const { data, error } = await supabase.rpc("update_content_post", {
    p_post_id: postId,
    p_expected_version: expectedVersion,
    p_title: current.title,
    p_body: current.body,
    p_status: status,
    p_scheduled_for: current.scheduled_for,
    p_change_source: changeSource,
  });
  return rpcResult(data, error);
}

/** Extra guards for patchPost, set by trusted server code (never by user input). */
export type PatchPostOptions = ContentWriteOptions & {
  /** The post must belong to this workspace (else not_found, nothing written). */
  workspaceId?: string;
  /** The post must currently have this status (else "not_allowed_status"). */
  requireStatus?: ContentPostStatus;
};

/**
 * Changes only the given fields of a post; every other field is sent back to
 * the update RPC exactly as stored (raw title, body, status and scheduled_for,
 * not re-validated), so nothing the caller did not ask to change can shift.
 *
 * Safety: the stored version must equal `expectedVersion` (checked here and
 * again atomically by the RPC, which raises CP409 if the post changed in
 * between); one write attempt only, never a retry. RLS and history as usual.
 */
export async function patchPost(input: unknown, options?: PatchPostOptions): Promise<ContentPost> {
  const changeSource = changeSourceOf(options);
  const patch = parseContentInput(postPatchSchema, input);
  const { supabase } = await contentClient();

  const { data: current, error: readError } = await supabase
    .from("content_posts")
    .select(POST_COLUMNS)
    .eq("id", patch.postId)
    .maybeSingle();
  if (readError) throw toContentError(readError);
  if (!current) throw new ContentError("not_found");
  if (options?.workspaceId !== undefined && current.workspace_id !== options.workspaceId) {
    throw new ContentError("not_found");
  }
  if (current.archived_at !== null) throw new ContentError("archived");
  if (options?.requireStatus !== undefined && current.status !== options.requireStatus) {
    throw new ContentError("not_allowed_status");
  }
  if (current.version !== patch.expectedVersion) throw new ContentError("version_conflict");

  const { data, error } = await supabase.rpc("update_content_post", {
    p_post_id: patch.postId,
    p_expected_version: patch.expectedVersion,
    p_title: patch.title ?? current.title,
    p_body: patch.body ?? current.body,
    p_status: current.status as "draft" | "ready",
    p_scheduled_for: patch.scheduledFor === undefined ? current.scheduled_for : patch.scheduledFor,
    p_change_source: changeSource,
  });
  return rpcResult(data, error);
}

/** Archives a post (any member). Requires the version the user is looking at. */
export async function archivePost(input: unknown, options?: ContentWriteOptions): Promise<ContentPost> {
  const changeSource = changeSourceOf(options);
  const { postId, expectedVersion } = parseContentInput(postVersionRefSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase.rpc("archive_content_post", {
    p_post_id: postId,
    p_expected_version: expectedVersion,
    p_change_source: changeSource,
  });
  return rpcResult(data, error);
}

/** Restores an archived post (any member; its project must be active). */
export async function restorePost(input: unknown, options?: ContentWriteOptions): Promise<ContentPost> {
  const changeSource = changeSourceOf(options);
  const { postId, expectedVersion } = parseContentInput(postVersionRefSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase.rpc("restore_content_post", {
    p_post_id: postId,
    p_expected_version: expectedVersion,
    p_change_source: changeSource,
  });
  return rpcResult(data, error);
}
