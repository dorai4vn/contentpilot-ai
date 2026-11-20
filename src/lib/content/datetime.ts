/**
 * Date-time helpers shared by the content UI (browser) and tests. Pure functions,
 * no server-only code.
 *
 * <input type="datetime-local"> works in the browser's local time without a zone
 * ("2026-12-01T09:00"). The backend only accepts ISO 8601 with an offset, so the
 * browser converts local -> UTC ISO before submitting.
 */

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** "2026-12-01T09:00" (browser local time) -> "2026-12-01T02:00:00.000Z"; "" -> null; invalid -> undefined. */
export function localInputToIso(local: string): string | null | undefined {
  const value = local.trim();
  if (value === "") return null;
  const match = LOCAL_INPUT.exec(value);
  if (!match) return undefined;
  const [y, mo, d, h, mi] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const s = match[6] === undefined ? 0 : Number(match[6]);
  const date = new Date(y, mo - 1, d, h, mi, s, 0);
  // Reject impossible dates (e.g. 31 February rolls over into March).
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return undefined;
  return date.toISOString();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO date-time (any offset) -> "YYYY-MM-DDTHH:mm" in the browser's local time; null/invalid -> "". */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Human-readable date-time. Pass timeZone "UTC" for output that is identical on server and client. */
export function formatDateTime(iso: string, options: { timeZone?: string; locale?: string } = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(options.locale ?? "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: options.timeZone,
  }).format(date);
}
