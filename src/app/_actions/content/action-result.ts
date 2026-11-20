import "server-only";

import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";

import {
  CONTENT_ERROR_MESSAGES,
  type ContentErrorCode,
  contentFieldErrors,
  toContentError,
} from "@/lib/content/errors";

/**
 * Shared plumbing for the content Server Actions (not itself a "use server" file).
 * Every action returns a serialisable ActionResult, usable with useActionState.
 * Error results only ever carry our own generic messages.
 */

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: ContentErrorCode;
      error: string;
      fieldErrors?: Partial<Record<string, string>>;
    };

/** Initial state for useActionState (no submission yet). */
export type ActionState<T = undefined> = ActionResult<T> | null;

export function failure(
  code: ContentErrorCode,
  fieldErrors?: Partial<Record<string, string>>,
): ActionResult<never> {
  return { ok: false, code, error: CONTENT_ERROR_MESSAGES[code], ...(fieldErrors ? { fieldErrors } : {}) };
}

/**
 * Turns submitted FormData into a plain object for zod. React's internal
 * `$ACTION_*` fields are ignored; every other field is passed on, so unexpected
 * ones (e.g. "version", "created_by") are rejected by the strict schemas instead
 * of being silently dropped. Files and repeated fields are rejected.
 */
export function formFields(
  formData: FormData,
): { ok: true; data: Record<string, string> } | { ok: false; result: ActionResult<never> } {
  const data: Record<string, string> = {};
  const fieldErrors: Partial<Record<string, string>> = {};

  for (const [key, value] of formData.entries()) {
    if (key.startsWith("$ACTION")) continue;
    if (typeof value !== "string") {
      fieldErrors[key] = "Không chấp nhận tệp ở trường này.";
    } else if (Object.hasOwn(data, key)) {
      fieldErrors[key] = "Trường này bị gửi nhiều lần.";
    } else {
      data[key] = value;
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, result: failure("invalid_input", fieldErrors) };
  return { ok: true, data };
}

/** Validates form fields with a zod schema; on failure returns an invalid_input result. */
export function parseForm<S extends z.ZodType>(
  schema: S,
  formData: FormData,
): { ok: true; data: z.output<S> } | { ok: false; result: ActionResult<never> } {
  const fields = formFields(formData);
  if (!fields.ok) return fields;
  const parsed = schema.safeParse(fields.data);
  if (!parsed.success) return { ok: false, result: failure("invalid_input", contentFieldErrors(parsed.error)) };
  return { ok: true, data: parsed.data };
}

/**
 * Runs a data-layer call and converts thrown errors into a safe ActionResult.
 * Next.js control-flow errors (redirect, notFound) are re-thrown untouched.
 * `onSuccess` (revalidation) runs only after the call succeeded.
 */
export async function runAction<R, T>(
  call: () => Promise<R>,
  onSuccess: (result: R) => T,
): Promise<ActionResult<T>> {
  let result: R;
  try {
    result = await call();
  } catch (error) {
    unstable_rethrow(error);
    const contentError = toContentError(error);
    if (contentError.code === "unknown") {
      // Server log only; the client receives the generic message.
      console.error("[content action] unexpected error", error);
    }
    return failure(contentError.code, contentError.fieldErrors);
  }
  return { ok: true, data: onSuccess(result) };
}
