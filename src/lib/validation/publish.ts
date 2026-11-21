import { z } from "zod";

import { codePointLength, expectedVersionSchema, uuidSchema } from "./content";

/**
 * Input schemas for the M4 publish-approval data layer.
 *
 * Every schema is strict: keys the client must never control — requested_by,
 * decided_by, user_id, role, status, workspace_id of a decision, timestamps,
 * request_source / agent turn — are rejected, not silently dropped. The database
 * sets those from auth.uid() / now() (supabase/migrations/20261120200000_publish_approval.sql).
 */

export const PUBLISH_LIMITS = {
  /** Same bound as the database CHECKs on reason / decision_note (code points). */
  noteMax: 500,
  listMax: 100,
} as const;

/** Optional free text (reason / rejection note): trimmed, empty -> null, at most 500 code points. */
function optionalNote(label: string) {
  return z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const trimmed = typeof v === "string" ? v.trim() : "";
      return trimmed === "" ? null : trimmed;
    })
    .refine((v) => v === null || !v.includes("\u0000"), { message: `${label} chứa ký tự không hợp lệ.` })
    .refine((v) => v === null || codePointLength(v) <= PUBLISH_LIMITS.noteMax, {
      message: `${label} tối đa ${PUBLISH_LIMITS.noteMax} ký tự.`,
    });
}

/** Ask for the post to be published at exactly the version the user is looking at. */
export const publishRequestCreateSchema = z.strictObject({
  postId: uuidSchema,
  expectedVersion: expectedVersionSchema,
  reason: optionalNote("Lý do"),
  /**
   * The destination (M4.6). Must be an active destination of the post's
   * workspace. Omitted only by legacy M4 callers: then the data layer resolves
   * the workspace's internal destination explicitly. Required for the agent.
   */
  destinationId: uuidSchema.optional(),
});
export type PublishRequestCreateInput = z.input<typeof publishRequestCreateSchema>;

/** Approve: the request and the post version the approver was shown. */
export const publishApproveSchema = z.strictObject({
  requestId: uuidSchema,
  expectedPostVersion: expectedVersionSchema,
  /** The destination the approver was shown (M4.6). Required by the approve form. */
  expectedDestinationId: uuidSchema.optional(),
});
export type PublishApproveInput = z.input<typeof publishApproveSchema>;

export const publishRejectSchema = z.strictObject({
  requestId: uuidSchema,
  note: optionalNote("Ghi chú"),
});
export type PublishRejectInput = z.input<typeof publishRejectSchema>;

export const publishRequestRefSchema = z.strictObject({ requestId: uuidSchema });

export const PUBLISH_REQUEST_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;

export const publishRequestListSchema = z.strictObject({
  workspaceId: uuidSchema,
  postId: uuidSchema.optional(),
  status: z.enum(PUBLISH_REQUEST_STATUSES, { message: "Trạng thái không hợp lệ." }).optional(),
  limit: z.number().int().min(1).max(PUBLISH_LIMITS.listMax).optional().default(50),
});
export type PublishRequestListInput = z.input<typeof publishRequestListSchema>;

/** Display filters of the approval queue ("expired" = pending past expires_at). */
export const PUBLISH_QUEUE_FILTERS = ["pending", "expired", "approved", "rejected", "cancelled", "all"] as const;
export type PublishQueueFilter = (typeof PUBLISH_QUEUE_FILTERS)[number];

/** Server-side pagination of the approval queue (stable order, exact totals). */
export const publishRequestPageSchema = z.strictObject({
  workspaceId: uuidSchema,
  filter: z.enum(PUBLISH_QUEUE_FILTERS, { message: "Bộ lọc không hợp lệ." }).optional().default("pending"),
  page: z.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.number().int().min(1).max(PUBLISH_LIMITS.listMax).optional().default(20),
});
export type PublishRequestPageInput = z.input<typeof publishRequestPageSchema>;

export const publishRequestCountSchema = z.strictObject({ workspaceId: uuidSchema });
