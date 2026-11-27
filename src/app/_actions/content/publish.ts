"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/dal";
import { ContentError, type ContentErrorCode } from "@/lib/content/errors";
import { contentPaths } from "@/lib/content/paths";
import {
  approvePublishRequest,
  cancelPublishRequest,
  getPublishRequest,
  type ApprovedPost,
  type PublishRequest,
  rejectPublishRequest,
  requestPostPublish,
} from "@/lib/content/publish-requests";
import {
  approvePublishFormSchema,
  bulkApprovePublishSchema,
  cancelPublishFormSchema,
  rejectPublishFormSchema,
  requestPublishFormSchema,
} from "@/lib/validation/publish-actions";

import { type ActionResult, type ActionState, failure, parseForm, runAction } from "./action-result";

/**
 * Server Actions for M4 human approval of publishing — the HUMAN path only.
 *
 * - Every action re-verifies the session (requireUser) and validates the form with
 *   a strict schema: no user id, role, approved/published state or approver is
 *   accepted from the client.
 * - Writes go through the M4.2 data layer (src/lib/content/publish-requests.ts),
 *   which uses the user's own Supabase session (RLS); the database RPCs decide.
 * - Approval is its own action, triggered only by an explicit form submission
 *   carrying confirm=approve. Nothing here approves as a side effect of reading,
 *   loading a page or sending a request.
 * - The AI agent never reaches these actions: agent code may not import them
 *   (ESLint rule + unit test). The agent path (M4.6) will use the data layer's
 *   request function only and send the agent marker header, which makes the
 *   database refuse approve/reject. The absence of that header is never treated
 *   as proof that a human is acting: human authority comes from the session and
 *   the owner/admin role checked by the database.
 * - CSRF: Next.js Server Actions accept only POST and compare Origin with Host
 *   (no serverActions.allowedOrigins override in next.config.ts).
 */

export type PublishActionData = {
  workspaceId: string;
  postId: string;
  requestId: string;
  requestStatus: PublishRequest["status"];
  /** Post status after approval. External deliveries are queued. */
  postStatus?: ApprovedPost["status"];
  /** New post version after publishing (the post page must reload with it). */
  postVersion?: number;
};

function revalidatePublishPaths(workspaceId: string, postId: string, projectId?: string) {
  revalidatePath(contentPaths.post(workspaceId, postId));
  revalidatePath(contentPaths.approvals(workspaceId));
  revalidatePath(contentPaths.workspace(workspaceId));
  if (projectId) revalidatePath(contentPaths.project(workspaceId, projectId));
}

function requestDone(request: PublishRequest): PublishActionData {
  revalidatePublishPaths(request.workspaceId, request.postId);
  return {
    workspaceId: request.workspaceId,
    postId: request.postId,
    requestId: request.id,
    requestStatus: request.status,
  };
}

/**
 * The request must exist, be visible to the user and belong to the workspace of
 * the page the form came from (checked against the stored row, never trusted
 * from the form). Anything else is reported as not_found.
 */
async function requestInWorkspace(requestId: string, workspaceId: string): Promise<PublishRequest> {
  const detail = await getPublishRequest({ requestId });
  if (!detail || detail.request.workspaceId !== workspaceId) throw new ContentError("not_found");
  return detail.request;
}

/** Fields: workspaceId, postId, expectedVersion, destinationId, reason? */
export async function requestPublishAction(
  _prev: ActionState<PublishActionData>,
  formData: FormData,
): Promise<ActionResult<PublishActionData>> {
  await requireUser();
  const input = parseForm(requestPublishFormSchema, formData);
  if (!input.ok) return input.result;
  const { workspaceId, postId, expectedVersion, reason, destinationId } = input.data;
  // Human request: source "user" (the data-layer default). The workspace option
  // makes the data layer verify the post belongs to this workspace, and the
  // destination must be an active destination of that workspace.
  return runAction(
    () => requestPostPublish({ postId, expectedVersion, reason, destinationId }, { workspaceId }),
    requestDone,
  );
}

/**
 * Explicit approval by an owner/admin, scoped to the destination and version the
 * approver was shown. Fields: workspaceId, requestId, expectedPostVersion,
 * expectedDestinationId, confirm ("approve").
 */
export async function approvePublishAction(
  _prev: ActionState<PublishActionData>,
  formData: FormData,
): Promise<ActionResult<PublishActionData>> {
  await requireUser();
  const input = parseForm(approvePublishFormSchema, formData);
  if (!input.ok) return input.result;
  const { workspaceId, requestId, expectedPostVersion, expectedDestinationId } = input.data;
  return runAction(
    async () => {
      await requestInWorkspace(requestId, workspaceId);
      return approvePublishRequest({ requestId, expectedPostVersion, expectedDestinationId });
    },
    (post: ApprovedPost): PublishActionData => {
      revalidatePublishPaths(post.workspaceId, post.id, post.projectId);
      return {
        workspaceId: post.workspaceId,
        postId: post.id,
        requestId,
        requestStatus: "approved",
        postStatus: post.status,
        postVersion: post.version,
      };
    },
  );
}

/** Rejection by an owner/admin; the post is not changed. Fields: workspaceId, requestId, note? */
export async function rejectPublishAction(
  _prev: ActionState<PublishActionData>,
  formData: FormData,
): Promise<ActionResult<PublishActionData>> {
  await requireUser();
  const input = parseForm(rejectPublishFormSchema, formData);
  if (!input.ok) return input.result;
  const { workspaceId, requestId, note } = input.data;
  return runAction(async () => {
    await requestInWorkspace(requestId, workspaceId);
    return rejectPublishRequest({ requestId, note });
  }, requestDone);
}

/** Withdrawal by the requester or an owner/admin. Fields: workspaceId, requestId */
export async function cancelPublishAction(
  _prev: ActionState<PublishActionData>,
  formData: FormData,
): Promise<ActionResult<PublishActionData>> {
  await requireUser();
  const input = parseForm(cancelPublishFormSchema, formData);
  if (!input.ok) return input.result;
  const { workspaceId, requestId } = input.data;
  return runAction(async () => {
    await requestInWorkspace(requestId, workspaceId);
    return cancelPublishRequest({ requestId });
  }, requestDone);
}

export type BulkApproveItemResult =
  | {
      requestId: string;
      ok: true;
      postStatus: ApprovedPost["status"];
      postVersion: number;
    }
  | { requestId: string; ok: false; code: ContentErrorCode; error: string };

export type BulkApproveData = {
  workspaceId: string;
  results: BulkApproveItemResult[];
};

/**
 * Bulk approval by an owner/admin (issue #26). There is no new approval or
 * publish path: every item goes through exactly the same checks and the same
 * data-layer call as approvePublishAction (workspace scope, owner/admin role,
 * pending status, exact post version, exact destination, database RPC).
 * Items run sequentially, each is judged individually and its own result is
 * returned; a failing item never hides or rolls back the others. The batch is
 * bounded (BULK_APPROVE_MAX) and request ids must be unique.
 */
export async function bulkApprovePublishAction(
  input: unknown,
): Promise<ActionResult<BulkApproveData>> {
  await requireUser();
  const parsed = bulkApprovePublishSchema.safeParse(input);
  if (!parsed.success) return failure("invalid_input");
  const { workspaceId, items } = parsed.data;

  const results: BulkApproveItemResult[] = [];
  const touched: ApprovedPost[] = [];
  for (const item of items) {
    const outcome = await runAction(
      async () => {
        await requestInWorkspace(item.requestId, workspaceId);
        return approvePublishRequest({
          requestId: item.requestId,
          expectedPostVersion: item.expectedPostVersion,
          expectedDestinationId: item.expectedDestinationId,
        });
      },
      (post: ApprovedPost) => post,
    );
    if (outcome.ok) {
      touched.push(outcome.data);
      results.push({
        requestId: item.requestId,
        ok: true,
        postStatus: outcome.data.status,
        postVersion: outcome.data.version,
      });
    } else {
      results.push({
        requestId: item.requestId,
        ok: false,
        code: outcome.code,
        error: outcome.error,
      });
    }
  }
  for (const post of touched)
    revalidatePublishPaths(post.workspaceId, post.id, post.projectId);
  revalidatePath(contentPaths.approvals(workspaceId));
  return { ok: true, data: { workspaceId, results } };
}
