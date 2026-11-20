"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/dal";
import { contentPaths } from "@/lib/content/paths";
import {
  archivePost,
  type ContentPost,
  createPost,
  restorePost,
  setPostStatus,
  updatePost,
} from "@/lib/content/posts";
import {
  postCreateSchema,
  postStatusChangeSchema,
  postUpdateSchema,
  postVersionRefSchema,
} from "@/lib/validation/content";

import { type ActionResult, type ActionState, parseForm, runAction } from "./action-result";

/**
 * Server Actions for content posts. Each one re-verifies the session, validates the
 * form with zod and calls the data layer (RLS + RPCs). Changes to an existing post
 * require the version the user loaded; a concurrent edit returns
 * `version_conflict` and nothing is overwritten. There is no publish or delete.
 */

export type PostActionData = {
  postId: string;
  projectId: string;
  workspaceId: string;
  /** New version: the form must send it as expectedVersion on the next change. */
  version: number;
  status: ContentPost["status"];
  archived: boolean;
};

function done(post: ContentPost): PostActionData {
  revalidatePath(contentPaths.project(post.workspaceId, post.projectId));
  revalidatePath(contentPaths.post(post.workspaceId, post.id));
  return {
    postId: post.id,
    projectId: post.projectId,
    workspaceId: post.workspaceId,
    version: post.version,
    status: post.status,
    archived: post.archivedAt !== null,
  };
}

/** Fields: workspaceId, projectId, title, body, status, scheduledFor? */
export async function createPostAction(
  _prev: ActionState<PostActionData>,
  formData: FormData,
): Promise<ActionResult<PostActionData>> {
  await requireUser();
  const input = parseForm(postCreateSchema, formData);
  if (!input.ok) return input.result;
  return runAction(() => createPost(input.data), done);
}

/** Fields: postId, expectedVersion, title, body, status, scheduledFor? */
export async function updatePostAction(
  _prev: ActionState<PostActionData>,
  formData: FormData,
): Promise<ActionResult<PostActionData>> {
  await requireUser();
  const input = parseForm(postUpdateSchema, formData);
  if (!input.ok) return input.result;
  return runAction(() => updatePost(input.data), done);
}

/**
 * Switches a post between draft and ready. Only the status changes: the data
 * layer sends title, body and schedule back exactly as stored, and the database
 * rejects the change (version_conflict) if the post moved past expectedVersion.
 * Fields: postId, expectedVersion, status
 */
export async function setPostStatusAction(
  _prev: ActionState<PostActionData>,
  formData: FormData,
): Promise<ActionResult<PostActionData>> {
  await requireUser();
  const input = parseForm(postStatusChangeSchema, formData);
  if (!input.ok) return input.result;
  return runAction(() => setPostStatus(input.data), done);
}

/** Fields: postId, expectedVersion */
export async function archivePostAction(
  _prev: ActionState<PostActionData>,
  formData: FormData,
): Promise<ActionResult<PostActionData>> {
  await requireUser();
  const input = parseForm(postVersionRefSchema, formData);
  if (!input.ok) return input.result;
  return runAction(() => archivePost(input.data), done);
}

/** Fields: postId, expectedVersion */
export async function restorePostAction(
  _prev: ActionState<PostActionData>,
  formData: FormData,
): Promise<ActionResult<PostActionData>> {
  await requireUser();
  const input = parseForm(postVersionRefSchema, formData);
  if (!input.ok) return input.result;
  return runAction(() => restorePost(input.data), done);
}
