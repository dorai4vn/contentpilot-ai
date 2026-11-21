import { z } from "zod";

import { uuidSchema } from "./content";

/** Read-only queries of the publishing module (strict: unknown keys are rejected). */

export const destinationListSchema = z.strictObject({
  workspaceId: uuidSchema,
  includeDisabled: z.boolean().optional().default(false),
});
export type DestinationListInput = z.input<typeof destinationListSchema>;

export const destinationRefSchema = z.strictObject({ destinationId: uuidSchema });

export const internalDestinationSchema = z.strictObject({ workspaceId: uuidSchema });

/** Deliveries of one post or of one request (exactly one of them), inside one workspace. */
export const deliveryListSchema = z
  .strictObject({
    workspaceId: uuidSchema,
    postId: uuidSchema.optional(),
    requestId: uuidSchema.optional(),
    limit: z.number().int().min(1).max(100).optional().default(50),
  })
  .refine((v) => (v.postId === undefined) !== (v.requestId === undefined), {
    message: "Cần đúng một trong hai: bài viết hoặc yêu cầu.",
    path: ["form"],
  });
export type DeliveryListInput = z.input<typeof deliveryListSchema>;
