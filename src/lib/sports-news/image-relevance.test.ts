import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ageGroups, decideFromScores, provenanceRejection, resetRelevanceStateForTests, validateImageRelevance } from "./image-relevance";

vi.mock("server-only", () => ({}));
beforeEach(() => resetRelevanceStateForTests());

const jpeg = () => sharp({ create: { width: 640, height: 480, channels: 3, background: "#284" } }).jpeg().toBuffer();
const ctx = { title: "Arsenal vs Man City", method: "og_image", sourceUrl: "https://x.vn/a.jpg" };

describe("decideFromScores", () => {
  it("passes a clear football image and rejects negatives/ambiguity", () => {
    expect(decideFromScores({ football: 0.6, negative: 0.1, topNegative: "" })).toBeNull();
    expect(decideFromScores({ football: 0.05, negative: 0.4, topNegative: "art" })).toBe("negative_class");
    expect(decideFromScores({ football: 0.05, negative: 0.01, topNegative: "" })).toBe("low_football_score");
    expect(decideFromScores({ football: 0.3, negative: 0.2, topNegative: "street" })).toBe("ambiguous");
  });
});

describe("provenance", () => {
  it("detects age group conflicts and uncorroborated non-article images", () => {
    expect([...ageGroups("U-17 Nhật Bản vs Honduras, under 20")].sort()).toEqual([17, 20]);
    expect(provenanceRejection({ ...ctx, title: "U17 Nhật Bản Honduras", hint: "Japan U20 squad" })).toBe("age_group_conflict");
    expect(provenanceRejection({ ...ctx, title: "Arsenal thắng", hint: "u19 training" })).toBe("age_group_conflict");
    expect(provenanceRejection({ ...ctx, method: "search_provider", hint: "random pitch" })).toBe("not_corroborated");
    expect(provenanceRejection({ ...ctx, method: "search_provider", hint: "Arsenal Man City 2024" })).toBeNull();
  });
});

describe("validateImageRelevance (MOCK scorer; not real visual QC)", () => {
  it("passes then serves the second call from cache", async () => {
    const scorer = vi.fn(async () => ({ football: 0.7, negative: 0.01, topNegative: "" }));
    const bytes = await jpeg();
    expect(await validateImageRelevance(bytes, ctx, { scorer })).toMatchObject({ ok: true, cached: false });
    expect(await validateImageRelevance(bytes, ctx, { scorer })).toMatchObject({ ok: true, cached: true });
    expect(scorer).toHaveBeenCalledTimes(1);
  });
  it("model error, timeout and undecodable bytes fail closed and are not cached", async () => {
    const bytes = await jpeg();
    const failing = vi.fn(async () => { throw new Error("boom"); });
    expect(await validateImageRelevance(bytes, ctx, { scorer: failing })).toEqual({ ok: false, reason: "model_error" });
    expect(await validateImageRelevance(bytes, ctx, { scorer: failing })).toEqual({ ok: false, reason: "model_error" });
    expect(failing).toHaveBeenCalledTimes(2);
    const slow = () => new Promise<never>(() => undefined);
    expect(await validateImageRelevance(bytes, ctx, { scorer: slow, timeoutMs: 20 })).toEqual({ ok: false, reason: "model_timeout" });
    expect(await validateImageRelevance(new Uint8Array(50), ctx, { scorer: vi.fn() })).toEqual({ ok: false, reason: "crop_failed" });
  });
});

describe("A3b hardening (MOCK scorer; not real visual QC)", () => {
  it("rejects non-finite / out-of-range / missing scores", () => {
    for (const bad of [{ football: NaN, negative: 0.1 }, { football: 0.5, negative: Infinity }, { football: 2, negative: 0 }, undefined]) {
      expect(decideFromScores(bad as never)).toBe("invalid_scores");
    }
  });
  it("wrong team in hint rejects even for article-embedded images; single token is not corroboration", () => {
    expect(provenanceRejection({ ...ctx, hint: "Chelsea fans" })).toBe("entity_conflict");
    expect(provenanceRejection({ ...ctx, method: "wikimedia", title: "Tottenham thua Brighton", hint: "stadium match 2020" })).toBe("not_corroborated");
    expect(provenanceRejection({ ...ctx, method: "wikimedia", title: "Declan Rice ghi bàn", hint: "Declan Rice portrait" })).toBeNull();
  });
  it("passes topic to the scorer and serialises inference; a timed-out run keeps the model busy (no overlap)", async () => {
    const bytes = await jpeg();
    const seen: unknown[] = [];
    const scorer = vi.fn(async (_b: Uint8Array, topic?: string) => { seen.push(topic); return { football: 0.7, negative: 0.01, topNegative: "" }; });
    await validateImageRelevance(bytes, { ...ctx, title: "Arteta họp báo" }, { scorer });
    expect(seen).toEqual(["press_conference"]);
    resetRelevanceStateForTests();
    let running = 0; let maxRunning = 0;
    const slow = async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 80)); running--; return { football: 0.7, negative: 0.01, topNegative: "" }; };
    const first = validateImageRelevance(bytes, { ...ctx, hint: "a" }, { scorer: slow, timeoutMs: 20 });
    const second = validateImageRelevance(bytes, { ...ctx, hint: "b" }, { scorer: slow, timeoutMs: 500 });
    expect(await first).toEqual({ ok: false, reason: "model_timeout" });
    expect(await second).toEqual({ ok: false, reason: "model_busy" });
    expect(maxRunning).toBe(1);
  });
});
