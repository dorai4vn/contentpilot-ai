import { afterEach, expect, it, vi } from "vitest";
import { findSourceSportsPhoto } from "./source-photo";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllGlobals());

it("uses the article's own lead image", async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('<meta property="og:image" content="https://images2.thanhnien.vn/story.jpeg">', { headers: { "content-type": "text/html" } }))
    .mockResolvedValueOnce(new Response(new Uint8Array(1000), { headers: { "content-type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(findSourceSportsPhoto({ source: "Thanh Niên", url: "https://thanhnien.vn/story.htm", title: "Tin", summary: "Tóm tắt", publishedAt: Date.now() }))
    .resolves.toMatchObject({ metadata: { source: "https://images2.thanhnien.vn/story.jpeg" } });
});
