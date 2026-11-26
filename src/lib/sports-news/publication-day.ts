import type { Json } from "@/types/database";

const calendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Dubai", year: "numeric", month: "numeric", day: "numeric",
});

export function publishedToday(publishedAt: number, now = Date.now()): boolean {
  return Number.isFinite(publishedAt) && publishedAt <= now &&
    calendar.format(publishedAt) === calendar.format(now);
}

export function sportsArticleIsCurrent(assessment: Json, now = Date.now()): boolean {
  const publishedAt = assessment && typeof assessment === "object" && !Array.isArray(assessment)
    ? assessment.publishedAt
    : undefined;
  return typeof publishedAt === "string" && publishedToday(Date.parse(publishedAt), now);
}
