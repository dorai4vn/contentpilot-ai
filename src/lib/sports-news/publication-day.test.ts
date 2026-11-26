import { expect, it } from "vitest";
import { publishedToday, sportsArticleIsCurrent } from "./publication-day";

it("rejects old or future items and changes dates at Dubai midnight", () => {
  const now = Date.parse("2026-11-26T20:30:00Z");
  expect(publishedToday(Date.parse("2026-11-26T20:00:00Z"), now)).toBe(true);
  expect(publishedToday(Date.parse("2026-11-26T19:59:59Z"), now)).toBe(false);
  expect(publishedToday(Date.parse("2026-11-26T20:31:00Z"), now)).toBe(false);
  expect(sportsArticleIsCurrent(null, now)).toBe(false);
  expect(sportsArticleIsCurrent({ publishedAt: "2026-11-26T20:00:00Z" }, now)).toBe(true);
});

it("allows a dated test draft until its explicit cutoff", () => {
  const assessment = { publishedAt: "2026-11-26T09:00:00Z", testPublishUntil: "2026-11-27T20:30:00Z" };
  expect(sportsArticleIsCurrent(assessment, Date.parse("2026-11-27T20:29:59Z"))).toBe(true);
  expect(sportsArticleIsCurrent(assessment, Date.parse("2026-11-27T20:30:00Z"))).toBe(false);
});
