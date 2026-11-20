import "server-only";

import {
  postCreateSchema,
  postListSchema,
  postRefSchema,
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
 * same transaction. There is no publish and no delete function in M2.
 */

/** M2 has no agent: every change made through this module is a user change. */
const CHANGE_SOURCE: ContentChangeSource = "user";

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
export async function createPost(input: unknown): Promise<ContentPost> {
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
      last_change_source: CHANGE_SOURCE,
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
export async function updatePost(input: unknown): Promise<ContentPost> {
  const { postId, expectedVersion, title, body, status, scheduledFor } = parseContentInput(postUpdateSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase.rpc("update_content_post", {
    p_post_id: postId,
    p_expected_version: expectedVersion,
    p_title: title,
    p_body: body,
    p_status: status,
    p_scheduled_for: scheduledFor,
    p_change_source: CHANGE_SOURCE,
  });
  return rpcResult(data, error);
}

/** Archives a post (any member). Requires the version the user is looking at. */
export async function archivePost(input: unknown): Promise<ContentPost> {
  const { postId, expectedVersion } = parseContentInput(postVersionRefSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase.rpc("archive_content_post", {
    p_post_id: postId,
    p_expected_version: expectedVersion,
    p_change_source: CHANGE_SOURCE,
  });
  return rpcResult(data, error);
}

/** Restores an archived post (any member; its project must be active). */
export async function restorePost(input: unknown): Promise<ContentPost> {
  const { postId, expectedVersion } = parseContentInput(postVersionRefSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase.rpc("restore_content_post", {
    p_post_id: postId,
    p_expected_version: expectedVersion,
    p_change_source: CHANGE_SOURCE,
  });
  return rpcResult(data, error);
}
