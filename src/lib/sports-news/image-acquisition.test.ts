import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { acquireSourceImage, configuredImageHosts, discoverCandidates, isPrivateAddress, rejectCandidateReason } from "./image-acquisition";

vi.mock("server-only", () => ({}));

const item = { source: "x", url: "https://thanhnien.vn/a.htm", title: "Arsenal thắng", summary: "s", publishedAt: Date.now() };
const publicDns = async () => ["93.184.216.34"];
// MOCK validator: these tests cover acquisition only; real relevance QC is in image-relevance.ts.
const passAll = async () => ({ ok: true as const, football: 0.9, negative: 0, cached: false, modelVersion: "mock" });
const failAll = async () => ({ ok: false as const, reason: "negative_class" as const });
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
const img = async (width = 800, height = 600) =>
  new Response(new Uint8Array(await sharp({ create: { width, height, channels: 3, background: "#123" } }).jpeg().toBuffer()), { headers: { "content-type": "image/jpeg" } });

describe("discoverCandidates", () => {
  it("collects RSS media, OG, Twitter, JSON-LD and lead image in priority order, deduped", () => {
    const page = `<meta property="og:image" content="/og.jpg"><meta name="twitter:image" content="/tw.jpg">
      <script type="application/ld+json">{"@graph":[{"image":{"url":"https://images2.thanhnien.vn/ld.jpg"}}]}</script>
      <article><img src="/og.jpg" alt="Lead"><img src="/lead.jpg"></article>`;
    const found = discoverCandidates(page, new URL(item.url), "https://images2.thanhnien.vn/rss.jpg");
    expect(found.map((c) => c.method)).toEqual(["rss_media", "og_image", "twitter_image", "json_ld"]);
  });
  it("ignores malformed JSON-LD", () => {
    expect(discoverCandidates('<script type="application/ld+json">{bad</script>', new URL(item.url))).toEqual([]);
  });
});

describe("rejection and config", () => {
  it("rejects logos, artworks and non-football hints", () => {
    expect(rejectCandidateReason({ url: "https://x.vn/site-logo.png", method: "og_image" })).toMatch(/logo/);
    expect(rejectCandidateReason({ url: "https://x.vn/a.jpg", method: "lead_image", hint: "Canaletto painting" })).toMatch(/painting/);
    expect(rejectCandidateReason({ url: "https://x.vn/arsenal-match.jpg", method: "og_image" })).toBeNull();
  });
  it("parses configured hosts and drops junk", () => {
    expect(configuredImageHosts("Arsenal.com, 10.0.0.1, bad host,premierleague.com")).toEqual(["arsenal.com", "premierleague.com"]);
  });
  it("flags private addresses", () => {
    for (const a of ["127.0.0.1", "10.1.1.1", "169.254.169.254", "192.168.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(a)).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });
});

describe("acquireSourceImage", () => {
  it("prefers RSS media, records provenance, marks unverified", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(html("<p>x</p>")).mockResolvedValueOnce(await img());
    const result = await acquireSourceImage({ ...item, imageUrl: "https://images2.thanhnien.vn/r.jpg" }, { fetchImpl, resolveHost: publicDns, allowedHosts: [], validate: passAll });
    expect(result?.metadata).toMatchObject({ method: "rss_media", verification: "local_hybrid", visualQc: "local_pass", articleUrl: item.url });
  });
  it("validator rejection drops the candidate and tries the next one, up to 5; all rejected => null", async () => {
    const validate = vi.fn().mockResolvedValueOnce(await failAll()).mockResolvedValueOnce(await passAll());
    const page = html('<meta property="og:image" content="https://images2.thanhnien.vn/a.jpg"><meta name="twitter:image" content="https://images2.thanhnien.vn/b.jpg">');
    const ok = vi.fn<typeof fetch>().mockResolvedValueOnce(page).mockResolvedValueOnce(await img()).mockResolvedValueOnce(await img());
    expect((await acquireSourceImage(item, { fetchImpl: ok, resolveHost: publicDns, allowedHosts: [], validate }))?.metadata.method).toBe("twitter_image");
    const none = vi.fn<typeof fetch>().mockResolvedValueOnce(html('<meta property="og:image" content="https://images2.thanhnien.vn/a.jpg">')).mockResolvedValueOnce(await img());
    expect(await acquireSourceImage(item, { fetchImpl: none, resolveHost: publicDns, allowedHosts: [], validate: failAll })).toBeNull();
  });
  it("substitutes next candidate when the first is too small, within the cap", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(html('<meta property="og:image" content="https://images2.thanhnien.vn/a.jpg"><meta name="twitter:image" content="https://images2.thanhnien.vn/b.jpg">'))
      .mockResolvedValueOnce(await img(100, 100)).mockResolvedValueOnce(await img());
    const result = await acquireSourceImage(item, { fetchImpl, resolveHost: publicDns, allowedHosts: [], validate: passAll });
    expect(result?.metadata.method).toBe("twitter_image");
  });
  it("rejects non-image bytes with an image MIME (signature check)", async () => {
    const fake = new Response(new Uint8Array(2000), { headers: { "content-type": "image/jpeg" } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(html('<meta property="og:image" content="https://images2.thanhnien.vn/a.jpg">')).mockResolvedValueOnce(fake);
    expect(await acquireSourceImage(item, { fetchImpl, resolveHost: publicDns, allowedHosts: [], validate: passAll })).toBeNull();
  });
  it("blocks image hosts outside the allowlist and private DNS answers", async () => {
    const off = vi.fn<typeof fetch>().mockResolvedValueOnce(html('<meta property="og:image" content="https://evil.example/a.jpg">'));
    expect(await acquireSourceImage(item, { fetchImpl: off, resolveHost: publicDns, allowedHosts: [], validate: passAll })).toBeNull();
    expect(off).toHaveBeenCalledTimes(1);
    const priv = vi.fn<typeof fetch>();
    expect(await acquireSourceImage(item, { fetchImpl: priv, resolveHost: async () => ["10.0.0.5"], allowedHosts: [], validate: passAll })).toBeNull();
    expect(priv).not.toHaveBeenCalled();
  });
  it("re-validates redirects: redirect to a disallowed host is refused", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(html('<meta property="og:image" content="https://images2.thanhnien.vn/a.jpg">'))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.example/x.jpg" } }));
    expect(await acquireSourceImage(item, { fetchImpl, resolveHost: publicDns, allowedHosts: [], validate: passAll })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("accepts configured official club hosts and ignores unlisted article hosts", async () => {
    const club = { ...item, url: "https://www.arsenal.com/news/x" };
    expect(await acquireSourceImage(club, { fetchImpl: vi.fn(), resolveHost: publicDns, allowedHosts: [], validate: passAll })).toBeNull();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(html('<meta property="og:image" content="https://www.arsenal.com/p/match.jpg">')).mockResolvedValueOnce(await img());
    expect((await acquireSourceImage(club, { fetchImpl, resolveHost: publicDns, allowedHosts: ["arsenal.com"], validate: passAll }))?.metadata.source).toBe("https://www.arsenal.com/p/match.jpg");
  });
  it("uses an injected search provider only after article candidates fail, and only on allowed hosts", async () => {
    const search = vi.fn(async () => [{ url: "https://cdn.tuoitre.vn/s.jpg", method: "search_provider" as const }]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(html("<p>none</p>")).mockResolvedValueOnce(await img());
    const r = await acquireSourceImage(item, { fetchImpl, resolveHost: publicDns, allowedHosts: ["tuoitre.vn"], validate: passAll, searchProvider: { name: "mock", search } });
    expect(search).toHaveBeenCalledTimes(1);
    expect(r?.metadata.method).toBe("search_provider");
  });
});
