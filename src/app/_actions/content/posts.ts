"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/dal";
import { ContentError } from "@/lib/content/errors";
import { contentPaths } from "@/lib/content/paths";
import {
  archivePost,
  type ContentPost,
  createPost,
  getPost,
  restorePost,
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
 * Switches a post between draft and ready, keeping its other fields. The caller's
 * expectedVersion is what the RPC checks, so an edit made meanwhile by someone
 * else is never overwritten with the stale title/body read here.
 * Fields: postId, expectedVersion, status
 */
export async function setPostStatusAction(
  _prev: ActionState<PostActionData>,
  formData: FormData,
): Promise<ActionResult<PostActionData>> {
  await requireUser();
  const input = parseForm(postStatusChangeSchema, formData);
  if (!input.ok) return input.result;
  const { postId, expectedVersion, status } = input.data;

  return runAction(async () => {
    const current = await getPost({ postId });
    if (!current) throw new ContentError("not_found");
    if (current.version !== expectedVersion) throw new ContentError("version_conflict");
    if (current.status === status) return current;
    return updatePost({
      postId,
      expectedVersion,
      title: current.title,
      body: current.body,
      status,
      scheduledFor: current.scheduledFor,
    });
  }, done);
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
