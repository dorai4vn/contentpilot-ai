import { z } from "zod";

import { codePointLength } from "./content";

/** Same bounds as the database CHECK on user_profiles.display_name. */
export const PROFILE_LIMITS = { displayNameMax: 60 } as const;

/** C0/C1 control characters (tabs, new lines, NUL, U+0080–U+009F…). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Display name: trimmed, 1–60 characters (code points, like Postgres
 * char_length), no control characters (checked before trimming). Repeated
 * inner spaces are collapsed.
 */
export const displayNameSchema = z
  .string({ message: "Vui lòng nhập tên hiển thị." })
  .refine((v) => !CONTROL_CHARS.test(v), { message: "Tên hiển thị chứa ký tự không hợp lệ." })
  .transform((v) => v.trim().replace(/ {2,}/g, " "))
  .refine((v) => codePointLength(v) >= 1, { message: "Vui lòng nhập tên hiển thị." })
  .refine((v) => codePointLength(v) <= PROFILE_LIMITS.displayNameMax, {
    message: `Tên hiển thị tối đa ${PROFILE_LIMITS.displayNameMax} ký tự.`,
  });

/** Account page form: only the display name. user_id is never accepted. */
export const profileUpdateSchema = z.strictObject({ displayName: displayNameSchema });
export type ProfileUpdateInput = z.input<typeof profileUpdateSchema>;

/** Optional display name at sign-up: empty -> null. */
export const optionalDisplayNameSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (typeof v === "string" && v.trim() !== "" ? v : null))
  .pipe(z.union([z.null(), displayNameSchema]));

export const profileIdsSchema = z.array(z.uuid()).max(500);
