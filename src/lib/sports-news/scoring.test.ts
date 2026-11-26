import { expect, it } from "vitest";
import { footballPriority, selectSportsNews } from "./scoring";

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

it("selects at most ten qualified stories per scan", () => {
  const item = { publishedAt: Date.now() };
  const stories = Array.from({ length: 12 }, (_, index) => ({ score: 10 - index / 10, priority: 1, item }));
  expect(selectSportsNews(stories, 8).selected).toHaveLength(10);
});
