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

function dateParts(iso: string, timeZone?: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: get("day"), month: get("month"), year: get("year"), hour: get("hour"), minute: get("minute") };
}

/**
 * Date and time as Vietnamese users write it: "01/12/2026 09:00" (dd/MM/yyyy, 24h).
 * Uses the runtime's local time zone unless one is given; pass "UTC" for output
 * that is identical on server and client. Display only: stored values stay UTC.
 */
export function formatDateTime(iso: string, options: { timeZone?: string } = {}): string {
  const p = dateParts(iso, options.timeZone);
  return p ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` : "";
}

/** Date only, "01/12/2026". */
export function formatDate(iso: string, options: { timeZone?: string } = {}): string {
  const p = dateParts(iso, options.timeZone);
  return p ? `${p.day}/${p.month}/${p.year}` : "";
}
