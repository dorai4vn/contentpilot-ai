import { expect, it } from "vitest";
import { footballPriority, scoreSportsNews, selectSportsNews, SPORTS_SCORING_RUBRIC } from "./scoring";

it("prioritizes the Premier League, C1, major football and Vietnamese football in order", () => {
  expect([
    "Ngoại hạng Anh: tin mới",
    "Lịch Cúp C1",
    "Lịch World Cup",
    "Đội tuyển Việt Nam công bố danh sách",
    "Bóng đá: một bàn thắng đẹp",
    "Billiards World Cup: cơ thủ Việt Nam",
  ].map((title) => footballPriority(title, ""))).toEqual([0, 1, 2, 3, 4, 5]);
});

it("chooses only the highest-scoring fallback, using competition priority to break ties", () => {
  const item = { publishedAt: 10 };
  const lowEpl = { score: 6, priority: 0, item };
  const topMajor = { score: 7, priority: 2, item };
  const topC1 = { score: 7, priority: 1, item };
  expect(selectSportsNews([lowEpl, topMajor, topC1], 8)).toEqual({ selected: [topC1], fallback: true });
  const qualified = { score: 8, priority: 5, item };
  expect(selectSportsNews([topC1, qualified], 8)).toEqual({ selected: [qualified], fallback: false });
  expect(selectSportsNews([], 8)).toEqual({ selected: [], fallback: false });
});

it("selects at most the default two qualified stories per scan, ranked descending", () => {
  const item = { publishedAt: Date.now() };
  const stories = Array.from({ length: 12 }, (_, index) => ({ score: 10 - index / 10, priority: 1, item }));
  const selected = selectSportsNews(stories, 8).selected;
  expect(selected.map((entry) => entry.score)).toEqual([10, 9.9]);
});

it("honours a configured posts-per-scan limit across all stories (1..10)", () => {
  const item = { publishedAt: Date.now() };
  const stories = Array.from({ length: 12 }, (_, index) => ({ score: 10 - index / 10, priority: 1, item }));
  expect(selectSportsNews(stories, 8, "highest", 1).selected).toHaveLength(1);
  expect(selectSportsNews(stories, 8, "highest", 5).selected.map((entry) => entry.score)).toEqual([10, 9.9, 9.8, 9.7, 9.6]);
  expect(selectSportsNews(stories, 8, "highest", 10).selected).toHaveLength(10);
  // threshold and highest fallback are unchanged by the limit
  expect(selectSportsNews([{ score: 6, priority: 1, item }, { score: 7, priority: 1, item }], 8, "highest", 5).selected).toHaveLength(1);
});

it("falls back to the single highest story when none reaches the default 8 threshold", () => {
  const item = { publishedAt: 1 };
  const stories = [7.5, 6, 7.9].map((score) => ({ score, priority: 1, item }));
  const result = selectSportsNews(stories, 8);
  expect(result.selected.map((entry) => entry.score)).toEqual([7.9]);
  expect(result.fallback).toBe(true);
});

it("uses the sports-v2 default weights: popularity 30, importance 25, recency 25, engagement 20", () => {
  const now = Date.parse("2026-11-27T10:00:00Z");
  expect(SPORTS_SCORING_RUBRIC.version).toBe("sports-v2");
  expect(SPORTS_SCORING_RUBRIC.weights).toEqual({ reach: 0.30, eventImportance: 0.25, freshness: 0.25, engagement: 0.20 });
  const assessment = { playerPopularity: 8, teamPopularity: 6, competitionPopularity: 4, eventImportance: 6, engagement: 10, reason: "t" };
  // 0.30*8 + 0.25*6 + 0.25*10 (just published) + 0.20*10 = 8.4
  expect(scoreSportsNews(assessment, now, now).score).toBe(8.4);
  // Recency follows the source publication time: 24h old -> freshness 5
  expect(scoreSportsNews(assessment, now - 24 * 3_600_000, now).freshness).toBe(5);
});

it("keeps legacy three-weight custom configurations working with engagement weight 0", () => {
  const now = Date.parse("2026-11-27T10:00:00Z");
  const base = { playerPopularity: 8, teamPopularity: 6, competitionPopularity: 4, eventImportance: 6, reason: "t" };
  const legacy = { reach: 0.45, eventImportance: 0.40, freshness: 0.15 };
  expect(scoreSportsNews({ ...base, engagement: 10 }, now, now, legacy).score)
    .toBe(scoreSportsNews(base, now, now, legacy).score);
});

it("uses configured weights and strict threshold without rescoring earlier entries", () => {
  const now = Date.parse("2026-11-27T10:00:00Z");
  const assessment = { playerPopularity: 10, teamPopularity: 4, competitionPopularity: 4, eventImportance: 2, reason: "test" };
  const defaults = scoreSportsNews(assessment, now, now).score;
  const weighted = scoreSportsNews(assessment, now, now, { reach: 0.8, eventImportance: 0.1, freshness: 0.1 }).score;
  expect(weighted).toBeGreaterThan(defaults);
  const entry = { score: 7.9, priority: 1, item: { publishedAt: now } };
  expect(selectSportsNews([entry], 8, "strict")).toEqual({ selected: [], fallback: false });
  expect(selectSportsNews([entry], 8, "highest")).toEqual({ selected: [entry], fallback: true });
});
