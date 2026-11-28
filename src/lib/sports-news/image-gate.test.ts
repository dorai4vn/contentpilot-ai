import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ read: vi.fn(), publish: vi.fn(), rpc: vi.fn(), article: { data: null as unknown, error: null } }));
vi.mock("./photo-snapshot", () => ({ readSportsPhoto: mocks.read }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { signInWithPassword: async () => ({ error: null }) },
    rpc: (n: string, a: unknown) => n === "get_sports_automation_mode"
      ? Promise.resolve({ data: [{ mode: "semi", daily_quota: 40 }], error: null }) : mocks.rpc(n, a),
    from: (t: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) c[m] = () => c;
      c.maybeSingle = async () => t === "sports_news_items" ? mocks.article : { data: { id: "tg" }, error: null };
      return c;
    },
  }),
}));
vi.mock("@/lib/env", () => ({ getSupabaseEnv: () => ({ url: "http://x", key: "k" }) }));
vi.mock("@/lib/publishing/registry", () => ({ getPublisher: () => ({ render: (s: unknown) => s, publish: mocks.publish }) }));
vi.mock("./feeds", () => ({ collectSportsNews: vi.fn() }));
vi.mock("./editor", () => ({ assessSportsNews: vi.fn(), writeSportsDraft: vi.fn() }));
vi.mock("./auto-delivery", () => ({ getTemporaryAutoWindow: vi.fn().mockResolvedValue(null), sendTemporarySportsPost: vi.fn() }));
vi.mock("./review-notices", () => ({ readReviewNoticeConfig: () => ({ botToken: "t", chatId: "1" }), sendReviewNotices: vi.fn() }));

import { requireRssImage } from "./image-gate";
import { readSportsNewsConfig, runSportsDelivery } from "./worker";

const TG = "88888888-8888-4888-8888-888888888888";
const row = { id: "d1", destination_id: TG, kind: "telegram", target_ref: "@c", idempotency_key: "k1", post_id: "p1", post_version: 1, title: "T", body: "B" };
const IMG = new Uint8Array([1, 2, 3]);

describe("requireRssImage", () => {
  beforeEach(() => vi.clearAllMocks());
  it("passes a valid image", async () => {
    mocks.read.mockResolvedValue(IMG);
    expect(await requireRssImage({} as never, "p", 1)).toEqual({ ok: true, image: IMG });
  });
  it("skips with no_image when absent or empty", async () => {
    mocks.read.mockResolvedValueOnce(null);
    expect(await requireRssImage({} as never, "p", 1)).toEqual({ ok: false, code: "no_image" });
    mocks.read.mockResolvedValueOnce(new Uint8Array());
    expect(await requireRssImage({} as never, "p", 1)).toEqual({ ok: false, code: "no_image" });
  });
  it("skips with image_invalid when the crop/read throws", async () => {
    mocks.read.mockRejectedValue(new Error("sharp"));
    expect(await requireRssImage({} as never, "p", 1)).toEqual({ ok: false, code: "image_invalid" });
  });
});

describe("approved/queued delivery gate", () => {
  const finished: Array<{ err: string | null; ext: string | null }> = [];
  beforeEach(() => {
    vi.clearAllMocks();
    finished.length = 0;
    Object.assign(process.env, {
      SPORTS_NEWS_WORKSPACE_ID: "22222222-2222-4222-8222-222222222222",
      SPORTS_NEWS_PROJECT_ID: "33333333-3333-4333-8333-333333333333",
      SPORTS_NEWS_WORKER_EMAIL: "w@example.com", SPORTS_NEWS_WORKER_PASSWORD: "pw", SPORTS_NEWS_TELEGRAM_DESTINATION_ID: TG,
    });
    let claimed = false;
    mocks.rpc.mockImplementation(async (n: string, a: Record<string, unknown>) => {
      if (n === "purge_sports_automation_history") return { data: 0, error: null };
      if (n === "claim_social_deliveries") { const d = claimed ? [] : [row]; claimed = true; return { data: d, error: null }; }
      if (n === "finish_social_delivery") { finished.push({ err: a.p_error_code as string | null, ext: a.p_external_id as string | null }); return { data: true, error: null }; }
      throw new Error(n);
    });
    mocks.publish.mockResolvedValue({ ok: true, externalId: "x" });
    mocks.article = { data: { assessment: { publishedAt: new Date(Date.now() - 1000).toISOString(), testPublishUntil: new Date(Date.now() + 3_600_000).toISOString() } }, error: null };
  });

  for (const [label, setup, code] of [
    ["missing image", () => mocks.read.mockResolvedValue(null), "no_image"],
    ["crop failure", () => mocks.read.mockRejectedValue(new Error("crop")), "image_invalid"],
  ] as const) {
    it(`RSS post with ${label} never reaches the publisher and records ${code}`, async () => {
      setup();
      await runSportsDelivery(readSportsNewsConfig());
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(finished).toEqual([{ err: code, ext: null }]);
    });
  }

  it("RSS post with a valid image is sent with the image", async () => {
    mocks.read.mockResolvedValue(IMG);
    await runSportsDelivery(readSportsNewsConfig());
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(finished).toEqual([{ err: null, ext: "x" }]);
  });

  it("manual non-RSS content (no sports row) still publishes without an image", async () => {
    mocks.article = { data: null, error: null };
    mocks.read.mockResolvedValue(null);
    await runSportsDelivery(readSportsNewsConfig());
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
});
