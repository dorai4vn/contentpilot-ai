import type { Json } from "@/types/database";

const calendar = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit",
});

export function dubaiDate(time: number): string {
  return calendar.format(time);
}

export function publishedToday(publishedAt: number, now = Date.now()): boolean {
  return Number.isFinite(publishedAt) && publishedAt <= now &&
    calendar.format(publishedAt) === calendar.format(now);
}

export function sportsArticleIsCurrent(assessment: Json, now = Date.now()): boolean {
  if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) return false;
  const publishedAt = typeof assessment.publishedAt === "string" ? Date.parse(assessment.publishedAt) : NaN;
  if (!Number.isFinite(publishedAt) || publishedAt > now) return false;
  const testUntil = typeof assessment.testPublishUntil === "string" ? Date.parse(assessment.testPublishUntil) : NaN;
  return publishedToday(publishedAt, now) || testUntil > now;
}
