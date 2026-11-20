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

function boundedText(label: string, { min, max, trim }: { min: number; max: number; trim: boolean }) {
  const base = trim ? z.string().trim() : z.string();
  return base
    .refine(noNul, { message: `${label} contains an invalid character.` })
    .refine((v) => codePointLength(v) >= min, {
      message: min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`,
    })
    .refine((v) => codePointLength(v) <= max, {
      message: `${label} must be at most ${max.toLocaleString("en-US")} characters.`,
    });
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** RFC 9562 UUID, normalised to lower case (as Postgres prints it). */
export const uuidSchema = z
  .string()
  .trim()
  .pipe(z.uuid({ message: "Invalid identifier." }))
  .transform((v) => v.toLowerCase());

/**
 * Optimistic-locking version sent back by the client. Accepts a positive integer
 * or its plain decimal string form (FormData); rejects "", "1.5", "1e3", "+1", "01".
 */
export const expectedVersionSchema = z
  .union([z.number(), z.string().trim().regex(/^[1-9]\d*$/, { message: "Invalid version." })])
  .transform((v) => (typeof v === "string" ? Number(v) : v))
  .pipe(
    z
      .number({ message: "Invalid version." })
      .int({ message: "Invalid version." })
      .min(1, { message: "Invalid version." })
      .max(CONTENT_LIMITS.versionMax, { message: "Invalid version." }),
  );

export const editablePostStatusSchema = z.enum(EDITABLE_POST_STATUSES, {
  message: "Status must be draft or ready.",
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
        .datetime({ offset: true, message: "Enter a valid date and time." })
        .transform((v) => new Date(v).toISOString()),
    ]),
  );

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Editable project fields (full state). Unknown keys are stripped. */
export const projectInputSchema = z.object({
  name: boundedText("Project name", { min: 1, max: CONTENT_LIMITS.projectNameMax, trim: true }),
  description: z
    .string()
    .nullish()
    .transform((v) => (v ?? "").trim())
    .pipe(
      boundedText("Description", { min: 0, max: CONTENT_LIMITS.projectDescriptionMax, trim: false }),
    )
    .transform((v) => (v === "" ? null : v)),
});

export type ProjectInput = z.infer<typeof projectInputSchema>;

export const projectCreateSchema = projectInputSchema.extend({ workspaceId: uuidSchema });
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = projectInputSchema.extend({ projectId: uuidSchema });
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

export const projectRefSchema = z.object({ projectId: uuidSchema });

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/**
 * Editable post fields. Updates replace the whole state, so every field is
 * required (an omitted body is an error, never a silent wipe). Unknown keys such
 * as version, created_by or published_at are stripped.
 */
export const postInputSchema = z.object({
  title: boundedText("Title", { min: 1, max: CONTENT_LIMITS.postTitleMax, trim: true }),
  // The body is stored as written (no trimming): whitespace can be meaningful.
  body: boundedText("Body", { min: 0, max: CONTENT_LIMITS.postBodyMax, trim: false }),
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
export const postVersionRefSchema = z.object({
  postId: uuidSchema,
  expectedVersion: expectedVersionSchema,
});
export type PostVersionRef = z.infer<typeof postVersionRefSchema>;
