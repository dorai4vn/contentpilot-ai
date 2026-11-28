import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  publish: vi.fn(),
  collect: vi.fn(),
  assess: vi.fn(),
  window: vi.fn(),
  mode: { data: [{ mode: "semi", daily_quota: 40 }], error: null } as { data: unknown; error: unknown },
}));
const WS = "22222222-2222-4222-8222-222222222222";
const TG = "88888888-8888-4888-8888-888888888888";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { signInWithPassword: async () => ({ error: null }) },
    rpc: (name: string, args: unknown) => name === "get_sports_automation_mode" ? Promise.resolve(mocks.mode) : mocks.rpc(name, args),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: table === "publishing_destinations" ? { id: TG } : null, error: null });
      return chain;
    },
  }),
}));
vi.mock("@/lib/env", () => ({ getSupabaseEnv: () => ({ url: "http://127.0.0.1:54321", key: "k" }) }));
vi.mock("@/lib/publishing/registry", () => ({
  getPublisher: () => ({ render: (s: unknown) => s, publish: mocks.publish }),
}));
vi.mock("./photo-snapshot", () => ({ readSportsPhoto: async () => null }));
vi.mock("./feeds", () => ({ collectSportsNews: mocks.collect }));
vi.mock("./editor", () => ({ assessSportsNews: mocks.assess, writeSportsDraft: mocks.assess }));
vi.mock("./auto-delivery", () => ({ getTemporaryAutoWindow: mocks.window, sendTemporarySportsPost: vi.fn() }));
vi.mock("./review-notices", () => ({
  readReviewNoticeConfig: () => ({ botToken: "tg-token", chatId: "1" }),
  sendReviewNotices: vi.fn(),
}));

import { DELIVERY_MAX_ROUNDS, readSportsNewsConfig, runSportsDelivery } from "./worker";

function delivery(n: number) {
  return {
    id: `d${n}`, destination_id: TG, kind: "telegram", target_ref: "@chan",
    idempotency_key: `key-${n}`, post_id: `p${n}`, post_version: 1, title: `T${n}`, body: "B",
  };
}

/** A fake database queue: claim hands out at most 6 rows and never the same row twice. */
function queue(count: number) {
  const pending = Array.from({ length: count }, (_, i) => delivery(i + 1));
  const finished: Array<{ id: string; ext: string | null; err: string | null }> = [];
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "purge_sports_automation_history") return { data: 0, error: null };
    if (name === "claim_social_deliveries") return { data: pending.splice(0, 6), error: null };
    if (name === "finish_social_delivery") {
      finished.push({ id: String(args.p_id), ext: args.p_external_id as string | null, err: args.p_error_code as string | null });
      return { data: true, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return { finished, pending };
}

const config = () => readSportsNewsConfig();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = { data: [{ mode: "semi", daily_quota: 40 }], error: null };
  Object.assign(process.env, {
    SPORTS_NEWS_WORKSPACE_ID: WS,
    SPORTS_NEWS_PROJECT_ID: "33333333-3333-4333-8333-333333333333",
    SPORTS_NEWS_WORKER_EMAIL: "worker@example.com",
    SPORTS_NEWS_WORKER_PASSWORD: "pw",
    SPORTS_NEWS_TELEGRAM_DESTINATION_ID: TG,
  });
  mocks.window.mockResolvedValue(null);
  mocks.publish.mockImplementation(async (_s: unknown, o: { idempotencyKey: string }) => ({ ok: true, externalId: `ext-${o.idempotencyKey}` }));
});

describe("runSportsDelivery (delivery-only)", () => {
  it("sends 8 approved items in two bounded rounds and never touches RSS or the LLM", async () => {
    const q = queue(8);
    const report = await runSportsDelivery(config());
    expect(report).toMatchObject({ rounds: 2, claimed: 8, delivered: 8, deliveryFailures: 0, truncated: false });
    expect(mocks.publish).toHaveBeenCalledTimes(8);
    expect(new Set(q.finished.map((f) => f.id)).size).toBe(8);
    expect(q.finished.every((f) => f.ext && !f.err)).toBe(true);
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.assess).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map(([n]) => n)).not.toContain("record_sports_news_assessment");
  });

  it("does nothing (single empty claim) when nothing is queued", async () => {
    queue(0);
    expect(await runSportsDelivery(config())).toMatchObject({ rounds: 1, claimed: 0, delivered: 0 });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("two concurrent workers never send the same delivery twice", async () => {
    queue(8);
    const [a, b] = await Promise.all([runSportsDelivery(config()), runSportsDelivery(config())]);
    expect(a.delivered + b.delivered).toBe(8);
    const keys = mocks.publish.mock.calls.map(([, o]) => o.idempotencyKey);
    expect(new Set(keys).size).toBe(8);
    expect(keys).toHaveLength(8);
  });

  it("records each failure individually with its error code and keeps delivering the rest", async () => {
    const q = queue(8);
    mocks.publish.mockImplementation(async (_s: unknown, o: { idempotencyKey: string }) =>
      o.idempotencyKey === "key-2" ? { ok: false, code: "rate_limited" }
        : o.idempotencyKey === "key-5" ? { ok: false, code: "provider_error" }
        : { ok: true, externalId: "x" });
    const report = await runSportsDelivery(config());
    expect(report).toMatchObject({ delivered: 6, deliveryFailures: 2 });
    expect(q.finished.filter((f) => f.err).map((f) => [f.id, f.err]).sort()).toEqual([["d2", "rate_limited"], ["d5", "provider_error"]]);
  });

  it("a delivery whose completion cannot be recorded counts as a failure, not a success", async () => {
    queue(1);
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "claim_social_deliveries" ? { data: [delivery(1)], error: null } : { data: false, error: null });
    expect(await runSportsDelivery(config())).toMatchObject({ delivered: 0, deliveryFailures: 1 });
  });

  it("is bounded: stops after the maximum number of rounds and reports truncation", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "claim_social_deliveries" ? { data: Array.from({ length: 6 }, (_, i) => delivery(i)), error: null } : { data: true, error: null });
    const report = await runSportsDelivery(config());
    expect(report.rounds).toBe(DELIVERY_MAX_ROUNDS);
    expect(report.truncated).toBe(true);
  });

  it("is bounded by the time budget", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "claim_social_deliveries" ? { data: Array.from({ length: 6 }, (_, i) => delivery(i)), error: null } : { data: true, error: null });
    let t = 0;
    const report = await runSportsDelivery(config(), () => (t += 60_000));
    expect(report.rounds).toBeLessThan(DELIVERY_MAX_ROUNDS);
    expect(report.truncated).toBe(true);
  });

  it("leaves the Telegram destination to an active auto-publish window", async () => {
    queue(3);
    mocks.window.mockResolvedValue({ ends_at: "2026-11-27T15:00:00Z" });
    const report = await runSportsDelivery(config());
    expect(report).toMatchObject({ autoPublishActive: true, claimed: 0 });
    expect(mocks.rpc.mock.calls.map(([n]) => n)).not.toContain("claim_social_deliveries");
  });

  it("Off performs no claim, no provider call and no destination lookup", async () => {
    queue(3);
    mocks.mode = { data: [{ mode: "off", daily_quota: 40 }], error: null };
    const report = await runSportsDelivery(config());
    expect(report).toMatchObject({ mode: "off", skipped: "automation_off", claimed: 0, delivered: 0 });
    // FN10: the only database call allowed while Off is the history-retention housekeeping.
    expect(mocks.rpc.mock.calls.map(([n]) => n)).toEqual(["purge_sports_automation_history"]);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

describe("FN10 history retention in the scheduler tick", () => {
  it("purges on delivery runs even when automation is Off, and a purge failure never fails the run", async () => {
    const calls: string[] = [];
    mocks.mode = { data: [{ mode: "off", daily_quota: 20 }], error: null };
    mocks.rpc.mockImplementation(async (name: string) => { calls.push(name); throw new Error("db down"); });
    const result = await runSportsDelivery(readSportsNewsConfig());
    expect(calls).toEqual(["purge_sports_automation_history"]);
    expect(result.skipped).toBe("automation_off");
    mocks.mode = { data: [{ mode: "semi", daily_quota: 40 }], error: null };
  });
});
