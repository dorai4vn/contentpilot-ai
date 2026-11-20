import { z } from "zod";

/**
 * Errors of the content data layer. Database errors are translated into a small
 * set of codes with generic, user-safe messages: the original Postgres / PostgREST
 * message, hint and details are never copied into the error, so they cannot leak
 * to the browser through a Server Action.
 *
 * SQLSTATEs raised by supabase/migrations/20261120120000_content_management.sql:
 *   CP404 not found or no access · CP409 version conflict · CP423 archived.
 */

export type ContentErrorCode =
  | "unauthenticated"
  | "not_found"
  | "version_conflict"
  | "archived"
  | "forbidden"
  | "invalid_input"
  | "unknown";

export const CONTENT_ERROR_MESSAGES: Record<ContentErrorCode, string> = {
  unauthenticated: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  not_found: "Không tìm thấy nội dung này hoặc bạn không có quyền truy cập.",
  version_conflict:
    "Bài viết đã được người khác cập nhật sau khi bạn mở. Hãy tải phiên bản mới nhất rồi áp dụng lại thay đổi của bạn.",
  archived: "Mục này đang được lưu trữ. Hãy khôi phục trước khi chỉnh sửa.",
  forbidden: "Bạn không có quyền thực hiện thao tác này.",
  invalid_input: "Một số thông tin chưa hợp lệ. Vui lòng kiểm tra lại.",
  unknown: "Đã có lỗi xảy ra. Vui lòng thử lại.",
};

export class ContentError extends Error {
  readonly code: ContentErrorCode;
  /** Per-field messages produced by our own validation (never by the database). */
  readonly fieldErrors?: Partial<Record<string, string>>;

  constructor(code: ContentErrorCode, fieldErrors?: Partial<Record<string, string>>) {
    super(CONTENT_ERROR_MESSAGES[code]);
    this.name = "ContentError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

const SQLSTATE_TO_CODE: Record<string, ContentErrorCode> = {
  CP404: "not_found",
  CP409: "version_conflict",
  CP423: "archived",
  "42501": "forbidden", // insufficient_privilege, RLS violation, publishing disabled
  "23514": "invalid_input", // check_violation
  "23502": "invalid_input", // not_null_violation
  "22023": "invalid_input", // invalid_parameter_value (raised by the RPCs)
  "22P02": "invalid_input", // invalid_text_representation (e.g. malformed uuid)
  "22021": "invalid_input", // character_not_in_repertoire (e.g. NUL byte)
  "22001": "invalid_input", // string_data_right_truncation
  "23503": "not_found", // foreign_key_violation: referenced project/workspace not visible
  PGRST116: "not_found", // PostgREST: .single() matched no row
};

/** Translates any database / client error into a ContentError with a generic message. */
export function toContentError(error: unknown): ContentError {
  if (error instanceof ContentError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return new ContentError((code && SQLSTATE_TO_CODE[code]) || "unknown");
}

/** Message for a field the client is not allowed to send (version, created_by…). */
export const FORBIDDEN_FIELD_MESSAGE = "Không được phép gửi trường này.";

/** Flattens zod issues into one message per field; rejected extra keys are named. */
export function contentFieldErrors(error: z.ZodError): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) result[key] ??= FORBIDDEN_FIELD_MESSAGE;
      continue;
    }
    const key = String(issue.path[0] ?? "form");
    result[key] ??= issue.message;
  }
  return result;
}

/** Validates input with a zod schema or throws ContentError("invalid_input"). */
export function parseContentInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ContentError("invalid_input", contentFieldErrors(parsed.error));
  }
  return parsed.data;
}
