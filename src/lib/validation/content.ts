import { z } from "zod";

/**
 * Validation for M2 content (projects and posts).
 *
 * Limits mirror the CHECK constraints in
 * supabase/migrations/20261120120000_content_management.sql (a unit test keeps
 * them in sync). Postgres `char_length` counts Unicode code points, so lengths
 * here are counted the same way rather than with String#length (UTF-16 units).
 * Text is trimmed of all whitespace, which is at least as strict as `btrim`.
 *
 * Input objects are strict: unknown keys (e.g. version, created_by, published_at)
 * are rejected, never silently dropped, so tampered requests are visible.
 *
 * Validation improves error messages; the database remains the authority.
 */

export const CONTENT_LIMITS = {
  projectNameMax: 100,
  projectDescriptionMax: 1000,
  postTitleMax: 200,
  postBodyMax: 50_000,
  /** Postgres `integer` upper bound (content_posts.version). */
  versionMax: 2_147_483_647,
} as const;

/** Statuses a user (or, in M3, the agent) may set. `published` is reserved for M4. */
export const EDITABLE_POST_STATUSES = ["draft", "ready"] as const;
export type EditablePostStatus = (typeof EDITABLE_POST_STATUSES)[number];

/** Length in Unicode code points, like Postgres char_length(). */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

// Postgres `text` cannot store NUL characters; reject them with a clear message.
const noNul = (value: string) => !value.includes("\u0000");

/** "1000" -> "1.000" (Vietnamese thousands separator), independent of the runtime locale. */
const viNumber = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** `label` is the field name as it starts a sentence, e.g. "Tên dự án". */
function boundedText(label: string, { min, max, trim }: { min: number; max: number; trim: boolean }) {
  const lower = label.charAt(0).toLocaleLowerCase("vi") + label.slice(1);
  const base = trim ? z.string().trim() : z.string();
  return base
    .refine(noNul, { message: `${label} chứa ký tự không hợp lệ.` })
    .refine((v) => codePointLength(v) >= min, {
      message: min === 1 ? `Vui lòng nhập ${lower}.` : `${label} phải có ít nhất ${min} ký tự.`,
    })
    .refine((v) => codePointLength(v) <= max, {
      message: `${label} tối đa ${viNumber(max)} ký tự.`,
    });
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** RFC 9562 UUID, normalised to lower case (as Postgres prints it). */
export const uuidSchema = z
  .string()
  .trim()
  .pipe(z.uuid({ message: "Mã định danh không hợp lệ." }))
  .transform((v) => v.toLowerCase());

/**
 * Optimistic-locking version sent back by the client. Accepts a positive integer
 * or its plain decimal string form (FormData); rejects "", "1.5", "1e3", "+1", "01".
 */
export const expectedVersionSchema = z
  .union([z.number(), z.string().trim().regex(/^[1-9]\d*$/, { message: "Phiên bản không hợp lệ." })])
  .transform((v) => (typeof v === "string" ? Number(v) : v))
  .pipe(
    z
      .number({ message: "Phiên bản không hợp lệ." })
      .int({ message: "Phiên bản không hợp lệ." })
      .min(1, { message: "Phiên bản không hợp lệ." })
      .max(CONTENT_LIMITS.versionMax, { message: "Phiên bản không hợp lệ." }),
  );

export const editablePostStatusSchema = z.enum(EDITABLE_POST_STATUSES, {
  message: "Trạng thái chỉ có thể là Bản nháp hoặc Sẵn sàng.",
});

/**
 * Planned publication time. Must be an ISO 8601 date-time with seconds and a UTC
 * offset (e.g. 2026-12-01T09:00:00+07:00 or Date#toISOString()): a bare local time would be ambiguous
 * on the server. Empty / missing means "not scheduled". Output: UTC ISO string or null.
 */
export const scheduledForSchema = z
  .string()
  .nullish()
  .transform((v) => (v ?? "").trim())
  .pipe(
    z.union([
      z.literal("").transform(() => null),
      z.iso
        .datetime({ offset: true, message: "Vui lòng nhập ngày giờ hợp lệ." })
        .transform((v) => new Date(v).toISOString()),
    ]),
  );

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Editable project fields (full state). Unknown keys are rejected. */
export const projectInputSchema = z.strictObject({
  name: boundedText("Tên dự án", { min: 1, max: CONTENT_LIMITS.projectNameMax, trim: true }),
  description: z
    .string()
    .nullish()
    .transform((v) => (v ?? "").trim())
    .pipe(
      boundedText("Mô tả", { min: 0, max: CONTENT_LIMITS.projectDescriptionMax, trim: false }),
    )
    .transform((v) => (v === "" ? null : v)),
});

export type ProjectInput = z.infer<typeof projectInputSchema>;

export const projectCreateSchema = projectInputSchema.extend({ workspaceId: uuidSchema });
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = projectInputSchema.extend({ projectId: uuidSchema });
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

export const projectRefSchema = z.strictObject({ projectId: uuidSchema });

export const projectListSchema = z.strictObject({
  workspaceId: uuidSchema,
  includeArchived: z.boolean().optional().default(false),
});
export type ProjectListInput = z.input<typeof projectListSchema>;

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/**
 * Editable post fields. Updates replace the whole state, so every field is
 * required (an omitted body is an error, never a silent wipe). Unknown keys such
 * as version, created_by or published_at are rejected.
 */
export const postInputSchema = z.strictObject({
  title: boundedText("Tiêu đề", { min: 1, max: CONTENT_LIMITS.postTitleMax, trim: true }),
  // The body is stored as written (no trimming): whitespace can be meaningful.
  body: boundedText("Nội dung", { min: 0, max: CONTENT_LIMITS.postBodyMax, trim: false }),
  status: editablePostStatusSchema,
  scheduledFor: scheduledForSchema,
});

export type PostInput = z.infer<typeof postInputSchema>;

export const postCreateSchema = postInputSchema.extend({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
});
export type PostCreateInput = z.infer<typeof postCreateSchema>;

export const postUpdateSchema = postInputSchema.extend({
  postId: uuidSchema,
  expectedVersion: expectedVersionSchema,
});
export type PostUpdateInput = z.infer<typeof postUpdateSchema>;

/** Archive / restore: identify the post and the version the user is looking at. */
export const postVersionRefSchema = z.strictObject({
  postId: uuidSchema,
  expectedVersion: expectedVersionSchema,
});
export type PostVersionRef = z.infer<typeof postVersionRefSchema>;

export const postRefSchema = z.strictObject({ postId: uuidSchema });

export const postListSchema = z.strictObject({
  projectId: uuidSchema,
  status: editablePostStatusSchema.optional(),
  includeArchived: z.boolean().optional().default(false),
});
export type PostListInput = z.input<typeof postListSchema>;

/** Draft <-> ready switch. The other fields are kept as they are in the database. */
export const postStatusChangeSchema = z.strictObject({
  postId: uuidSchema,
  expectedVersion: expectedVersionSchema,
  status: editablePostStatusSchema,
});
export type PostStatusChangeInput = z.infer<typeof postStatusChangeSchema>;
