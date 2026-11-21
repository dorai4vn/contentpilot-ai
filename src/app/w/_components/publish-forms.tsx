"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import type { ActionResult, ActionState } from "@/app/_actions/content/action-result";
import {
  approvePublishAction,
  cancelPublishAction,
  type PublishActionData,
  rejectPublishAction,
  requestPublishAction,
} from "@/app/_actions/content/publish";
import { PUBLISH_LIMITS } from "@/lib/validation/publish";

import { SubmitButton } from "./client-ui";
import { FieldError, FieldLabel, Notice, buttonClass, inputClass } from "./ui";

/**
 * Client forms of the M4 publish approval. Each one only submits to one of the
 * four Server Actions (M4.4); nothing is written any other way, and nothing runs
 * on mount. Approval needs two explicit steps: "Phê duyệt…" opens a confirmation
 * showing what will be published, and only the confirm button submits
 * (with confirm=approve).
 */

type State = ActionState<PublishActionData>;

/** Errors after which the data on screen is stale: offer to reload it. */
const RELOAD_CODES = new Set(["version_conflict", "request_closed", "request_expired", "post_published", "request_pending_exists"]);

function ActionError({ state, testId }: { state: ActionResult<PublishActionData> | null; testId: string }) {
  const router = useRouter();
  if (!state || state.ok) return null;
  const reload = RELOAD_CODES.has(state.code);
  return (
    <Notice tone={reload ? "warning" : "error"} testId={`${testId}-error`}>
      <span data-code={state.code}>{state.error}</span>
      {reload ? (
        <>
          {" "}
          Dữ liệu trên trang có thể đã cũ.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => router.refresh()}
            data-testid={`${testId}-reload`}
          >
            Tải lại dữ liệu
          </button>
        </>
      ) : null}
    </Notice>
  );
}

/** Refreshes the server data after a successful action. */
function useRefreshOnSuccess(state: State) {
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
}

export type DestinationOption = { id: string; name: string };

/**
 * Ask for publication of the post at the version shown, on one explicit
 * destination (today the workspace's internal destination: no picker until a
 * real external adapter exists).
 */
export function RequestPublishForm({
  workspaceId,
  postId,
  version,
  destination,
}: {
  workspaceId: string;
  postId: string;
  version: number;
  destination: DestinationOption;
}) {
  const [state, action] = useActionState<State, FormData>(requestPublishAction, null);
  useRefreshOnSuccess(state);
  const id = useId();
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form action={action} className="space-y-3" data-testid="request-publish-form">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="postId" value={postId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="destinationId" value={destination.id} />
      <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="request-publish-destination">
        Đích xuất bản: <span className="font-medium text-slate-800 dark:text-slate-200">{destination.name}</span>
      </p>
      <div>
        <FieldLabel htmlFor={`${id}-reason`}>Ghi chú cho người duyệt (không bắt buộc)</FieldLabel>
        <textarea
          id={`${id}-reason`}
          name="reason"
          rows={2}
          maxLength={PUBLISH_LIMITS.noteMax}
          className={inputClass}
          data-testid="request-publish-reason"
        />
        <FieldError message={errors?.reason} />
      </div>
      <SubmitButton pendingLabel="Đang gửi…" testId="request-publish-submit">
        Gửi yêu cầu xuất bản phiên bản {version}
      </SubmitButton>
      {state?.ok ? (
        <Notice tone="success" testId="request-publish-success">
          Đã gửi yêu cầu. Bài viết sẽ chỉ được xuất bản sau khi chủ sở hữu hoặc quản trị viên phê duyệt.
        </Notice>
      ) : null}
      <ActionError state={state} testId="request-publish" />
    </form>
  );
}

export type ApprovalTarget = {
  workspaceId: string;
  requestId: string;
  postTitle: string;
  postVersion: number;
  /** The destination this approval is for (shown and sent back as expectedDestinationId). */
  destinationId: string;
  destinationName: string;
};

/**
 * Two-step approval. Step 1 is a plain button (type="button": it submits nothing).
 * Step 2 shows what will be published and holds the only form that can approve.
 */
export function ApproveForm({ target }: { target: ApprovalTarget }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action] = useActionState<State, FormData>(approvePublishAction, null);
  useRefreshOnSuccess(state);

  if (state?.ok) {
    return (
      <Notice tone="success" testId="approve-success">
        Đã phê duyệt và xuất bản phiên bản {target.postVersion}.
      </Notice>
    );
  }

  if (!confirming) {
    return (
      <div className="space-y-2">
        <button type="button" className={buttonClass.primary} onClick={() => setConfirming(true)} data-testid="approve-start">
          Phê duyệt…
        </button>
        <ActionError state={state} testId="approve" />
      </div>
    );
  }

  return (
    <form
      action={action}
      className="space-y-3 rounded-md border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-950 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-100"
      data-testid="approve-confirm"
      role="alertdialog"
      aria-labelledby="approve-confirm-title"
    >
      <p id="approve-confirm-title" className="font-semibold">
        Xác nhận xuất bản
      </p>
      <p>
        Bạn sắp xuất bản <strong>phiên bản {target.postVersion}</strong> của bài viết{" "}
        <strong data-testid="approve-confirm-title-text">“{target.postTitle}”</strong> lên đích{" "}
        <strong data-testid="approve-confirm-destination">{target.destinationName}</strong>. Phê duyệt chỉ áp dụng cho
        đích này. Sau khi xuất bản, bài viết chỉ có thể xem, không sửa được nữa.
      </p>
      <input type="hidden" name="workspaceId" value={target.workspaceId} />
      <input type="hidden" name="requestId" value={target.requestId} />
      <input type="hidden" name="expectedPostVersion" value={target.postVersion} />
      <input type="hidden" name="expectedDestinationId" value={target.destinationId} />
      <input type="hidden" name="confirm" value="approve" />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingLabel="Đang xuất bản…" testId="approve-confirm-submit">
          Xác nhận phê duyệt và xuất bản
        </SubmitButton>
        <button type="button" className={buttonClass.ghost} onClick={() => setConfirming(false)} data-testid="approve-cancel">
          Quay lại
        </button>
      </div>
      <ActionError state={state} testId="approve" />
    </form>
  );
}

export function RejectForm({ workspaceId, requestId }: { workspaceId: string; requestId: string }) {
  const [state, action] = useActionState<State, FormData>(rejectPublishAction, null);
  useRefreshOnSuccess(state);
  const id = useId();
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  if (state?.ok) {
    return (
      <Notice tone="success" testId="reject-success">
        Đã từ chối yêu cầu. Bài viết không thay đổi.
      </Notice>
    );
  }
  return (
    <form action={action} className="space-y-2" data-testid="reject-form">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="requestId" value={requestId} />
      <FieldLabel htmlFor={`${id}-note`}>Lý do từ chối (không bắt buộc)</FieldLabel>
      <textarea
        id={`${id}-note`}
        name="note"
        rows={2}
        maxLength={PUBLISH_LIMITS.noteMax}
        className={inputClass}
        data-testid="reject-note"
      />
      <FieldError message={errors?.note} />
      <SubmitButton variant="warning" pendingLabel="Đang từ chối…" testId="reject-submit">
        Từ chối
      </SubmitButton>
      <ActionError state={state} testId="reject" />
    </form>
  );
}

export function CancelRequestForm({ workspaceId, requestId }: { workspaceId: string; requestId: string }) {
  const [state, action] = useActionState<State, FormData>(cancelPublishAction, null);
  useRefreshOnSuccess(state);
  if (state?.ok) {
    return (
      <Notice tone="success" testId="cancel-request-success">
        Đã hủy yêu cầu xuất bản.
      </Notice>
    );
  }
  return (
    <form action={action} className="space-y-2" data-testid="cancel-request-form">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="requestId" value={requestId} />
      <SubmitButton variant="secondary" pendingLabel="Đang hủy…" testId="cancel-request-submit">
        Hủy yêu cầu
      </SubmitButton>
      <ActionError state={state} testId="cancel-request" />
    </form>
  );
}
