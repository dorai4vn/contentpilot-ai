import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { findSourceSportsPhoto } from "./source-photo";

vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
afterEach(() => vi.unstubAllGlobals());

it("uses the article's own lead image (unverified candidate, never a QC pass)", async () => {
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#356" } }).jpeg().toBuffer();
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('<meta property="og:image" content="https://images2.thanhnien.vn/story.jpeg">', { headers: { "content-type": "text/html" } }))
    .mockResolvedValueOnce(new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(findSourceSportsPhoto({ source: "Thanh Niên", url: "https://thanhnien.vn/story.htm", title: "Tin", summary: "Tóm tắt", publishedAt: Date.now() }))
    .resolves.toMatchObject({ metadata: { source: "https://images2.thanhnien.vn/story.jpeg", method: "og_image", verification: "metadata_only", visualQc: "pending_a2", width: 800 } });
});
