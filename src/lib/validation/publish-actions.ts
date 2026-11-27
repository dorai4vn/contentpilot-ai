import { z } from "zod";

import { uuidSchema } from "./content";
import {
  publishApproveSchema,
  publishRejectSchema,
  publishRequestCreateSchema,
  publishRequestRefSchema,
} from "./publish";

/**
 * Form schemas of the M4 publish-approval Server Actions (human path only).
 *
 * They extend the data-layer schemas with `workspaceId`: the workspace of the page
 * the form was rendered on. The action checks it against the stored data (it can
 * only narrow access, never widen it). Everything else the client must not
 * control — user ids, roles, approved/published state, approver, timestamps,
 * request source or agent turn — is rejected by the strict schemas.
 */

/** The form always names its destination (M4.6): today the workspace's internal one. */
export const requestPublishFormSchema = publishRequestCreateSchema.extend({
  workspaceId: uuidSchema,
  destinationId: uuidSchema,
});
export type RequestPublishForm = z.output<typeof requestPublishFormSchema>;

/**
 * Approval needs an explicit intent field (`confirm=approve`) sent by the approve
 * button itself, in addition to the request and the post version the approver saw.
 */
export const approvePublishFormSchema = publishApproveSchema.extend({
  workspaceId: uuidSchema,
  /** The destination shown to the approver (M4.6): approval is scoped to it. */
  expectedDestinationId: uuidSchema,
  confirm: z.literal("approve", { message: "Thiếu xác nhận phê duyệt." }),
});
export type ApprovePublishForm = z.output<typeof approvePublishFormSchema>;

export const rejectPublishFormSchema = publishRejectSchema.extend({
  workspaceId: uuidSchema,
});
export type RejectPublishForm = z.output<typeof rejectPublishFormSchema>;

export const cancelPublishFormSchema = publishRequestRefSchema.extend({
  workspaceId: uuidSchema,
});
export type CancelPublishForm = z.output<typeof cancelPublishFormSchema>;

/** Upper bound of one bulk approval (owner decision on issue #26). */
export const BULK_APPROVE_MAX = 30;

/**
 * Bulk approval: the same per-item evidence as the single approval (request,
 * version and destination the approver saw), repeated per item. Duplicated
 * request ids are rejected so one request can never be submitted twice in a batch.
 */
export const bulkApprovePublishSchema = z
  .strictObject({
    workspaceId: uuidSchema,
    confirm: z.literal("approve", { message: "Thiếu xác nhận phê duyệt." }),
    items: z
      .array(
        z.strictObject({
          requestId: uuidSchema,
          expectedPostVersion: publishApproveSchema.shape.expectedPostVersion,
          expectedDestinationId: uuidSchema,
        }),
      )
      .min(1, "Chưa chọn yêu cầu nào.")
      .max(
        BULK_APPROVE_MAX,
        `Mỗi lần chỉ duyệt tối đa ${BULK_APPROVE_MAX} yêu cầu.`,
      ),
  })
  .refine(
    (v) => new Set(v.items.map((i) => i.requestId)).size === v.items.length,
    {
      message: "Danh sách có yêu cầu bị trùng.",
      path: ["items"],
    },
  );
export type BulkApprovePublishInput = z.input<typeof bulkApprovePublishSchema>;
