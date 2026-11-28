import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetRelevanceStateForTests } from "./image-relevance";
import { findSourceSportsPhoto, validateFallbackPhoto } from "./source-photo";

const model = vi.hoisted(() => ({ pipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("@huggingface/transformers", () => ({ env: {}, pipeline: model.pipeline, RawImage: { fromBlob: async () => ({}) } }));
beforeEach(() => { resetRelevanceStateForTests(); model.pipeline.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

const article = { source: "Thanh Niên", url: "https://thanhnien.vn/story.htm", title: "Arsenal thắng Man City", summary: "Tóm tắt", publishedAt: Date.now() };
async function stubArticle() {
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#356" } }).jpeg().toBuffer();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('<meta property="og:image" content="https://images2.thanhnien.vn/story.jpeg">', { headers: { "content-type": "text/html" } }))
    .mockResolvedValueOnce(new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg" } })));
  return jpeg;
}

// MOCK model (unit test of wiring only; this is NOT real visual QC).
const mockModel = (football: number, negative = 0) => async (_image: unknown, labels: string[]) => labels.map((label, index) => ({
  label, score: index === 0 ? football : index === labels.length - 1 ? negative : 0,
}));

it("returns the article image only after the (mock) local model passes it", async () => {
  await stubArticle();
  model.pipeline.mockResolvedValue(mockModel(0.8));
  await expect(findSourceSportsPhoto(article)).resolves.toMatchObject({
    metadata: { method: "og_image", verification: "local_hybrid", visualQc: "local_pass", width: 800, qc: { football: 0.8 } },
  });
});

it("fails closed when the model cannot be loaded", async () => {
  await stubArticle();
  model.pipeline.mockRejectedValue(new Error("fetch failed"));
  await expect(findSourceSportsPhoto(article)).resolves.toBeNull();
});

it("rejects a negative-class (artwork) image even with a source-article provenance", async () => {
  await stubArticle();
  model.pipeline.mockResolvedValue(mockModel(0.05, 0.9));
  await expect(findSourceSportsPhoto(article)).resolves.toBeNull();
});

it("a Wikimedia/fallback photo cannot bypass validation", async () => {
  const jpeg = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#356" } }).jpeg().toBuffer();
  const photo = { image: jpeg.toString("base64"), metadata: { source: "https://commons.wikimedia.org/?curid=1", title: "File:Arsenal vs Manchester City.jpg", license: null, licenseUrl: null, author: null, exactMatch: false } };
  model.pipeline.mockResolvedValue(mockModel(0.05, 0.9));
  await expect(validateFallbackPhoto(photo, article)).resolves.toBeNull();
  model.pipeline.mockReset();
  resetRelevanceStateForTests();
  model.pipeline.mockRejectedValue(new Error("no model"));
  await expect(validateFallbackPhoto(photo, article)).resolves.toBeNull();
  model.pipeline.mockReset();
  resetRelevanceStateForTests();
  model.pipeline.mockResolvedValue(mockModel(0.7));
  await expect(validateFallbackPhoto(photo, article)).resolves.toMatchObject({ metadata: { visualQc: "local_pass" } });
  // Not corroborated by the article's entities => rejected even if the model likes the pixels.
  await expect(validateFallbackPhoto({ ...photo, metadata: { ...photo.metadata, title: "File:Random pitch.jpg" } }, article)).resolves.toBeNull();
});

it("missing model labels (non-finite scores) fail closed", async () => {
  await stubArticle();
  model.pipeline.mockResolvedValue(async () => [{ label: "a photo of football players playing a soccer match on a pitch", score: 0.9 }]);
  await expect(findSourceSportsPhoto(article)).resolves.toBeNull();
});

it("combined budget: Wikimedia fallback cannot exceed the shared 5-candidate cap", async () => {
  const { createImageBudget } = await import("./image-budget");
  const jpeg = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#356" } }).jpeg().toBuffer();
  const photo = { image: jpeg.toString("base64"), metadata: { source: "https://commons.wikimedia.org/?curid=1", title: "File:Arsenal vs Manchester City.jpg", license: null, licenseUrl: null, author: null, exactMatch: false } };
  const budget = createImageBudget(5, 60_000);
  for (let i = 0; i < 5; i += 1) budget.take();
  model.pipeline.mockResolvedValue(mockModel(0.7));
  await expect(validateFallbackPhoto(photo, article, { budget })).resolves.toBeNull();
});
