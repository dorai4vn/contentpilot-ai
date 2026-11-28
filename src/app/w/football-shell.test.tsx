import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadWorkspace: vi.fn(), recentFootballNews: vi.fn(), recentEventDecisions: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/app/w/_lib/load", () => ({ loadWorkspace: mocks.loadWorkspace }));
vi.mock("@/app/w/_lib/football-news", () => ({ recentFootballNews: mocks.recentFootballNews, recentEventDecisions: mocks.recentEventDecisions }));

import FootballOverview from "./[workspaceId]/page";
import NewsFeedPage from "./[workspaceId]/news/page";

it("shows real workspace news in the new primary views", async () => {
  mocks.loadWorkspace.mockResolvedValue({ workspace: { id: "workspace-1", name: "Tin thể thao" } });
  mocks.recentFootballNews.mockResolvedValue([{
    source_url: "https://thanhnien.vn/fixture.htm", score: 8.6, has_image: true,
    assessment: null, created_at: "2026-11-27T01:00:00Z", post_id: null,
    title: "Nam Định gặp CAHN",
  }]);
  mocks.recentEventDecisions.mockResolvedValue([{
    source_url: "https://b.vn/dup", decision: "duplicate", created_at: "2026-11-27T02:00:00Z",
    reasons: [{ code: "same_team_pair", detail: "bayern vs lille" }, { code: "same_event_key", detail: null }],
    matchedSourceUrl: "https://a.vn/orig", matchedTitle: "Lille hạ Bayern 1-0",
  }]);
  const params = Promise.resolve({ workspaceId: "workspace-1" });
  const overview = renderToStaticMarkup(await FootballOverview({ params } as never));
  const feed = renderToStaticMarkup(await NewsFeedPage({ params } as never));

  expect(overview).toContain("Nam Định gặp CAHN");
  expect(overview).toContain("8.6");
  expect(feed).toContain("https://thanhnien.vn/fixture.htm");
  expect(mocks.recentFootballNews).toHaveBeenCalledWith("workspace-1", 30);
  expect(feed).toContain("Bỏ qua (trùng sự kiện)");
  expect(feed).toContain("Cùng cặp đội");
  expect(feed).toContain("Lille hạ Bayern 1-0");
});
