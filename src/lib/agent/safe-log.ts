/**
 * Safe server logging for the AI agent.
 *
 * Errors can carry sensitive data: database messages and details (PostgREST
 * "Failing row contains (...)" includes post content), OpenAI error messages
 * (may include part of the API key), stack traces with paths, request bodies.
 * Agent code therefore never logs an Error object or its message: only an
 * error class name and an error code, both restricted to short identifiers.
 */

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const CODE = /^[A-Za-z0-9_]{1,40}$/;

export type SafeErrorInfo = { type: string; code?: string };

/** Class name and code of an error, nothing else. Unknown shapes become "Error" / "non_error". */
export function safeErrorInfo(error: unknown): SafeErrorInfo {
  if (error === null || typeof error !== "object") return { type: "non_error" };
  const name = (error as { name?: unknown }).name;
  const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
  const type = [name, ctor].find((v): v is string => typeof v === "string" && IDENTIFIER.test(v)) ?? "Error";
  const rawCode = (error as { code?: unknown }).code;
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : undefined;
  return code !== undefined && CODE.test(code) ? { type, code } : { type };
}

/** A label from untrusted input (e.g. a tool name chosen by the model), or "unknown". */
export function safeLabel(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z_]{0,39}$/.test(value) ? value : "unknown";
}

/** The only way agent code writes errors to the server log. */
export function logAgentError(scope: string, fields: Record<string, string | undefined> & { error?: never }): void {
  const safe = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  console.error(`[${scope}]`, JSON.stringify(safe));
}
