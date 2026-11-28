import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  items: [] as Row[], posts: [] as Row[], requests: [] as Row[],
  rpc: vi.fn(), mode: { data: [{ mode: "semi", daily_quota: 40 }], error: null } as { data: unknown; error: unknown }, send: vi.fn(), autoWindow: null as unknown, deliveries: [] as Row[], collect: vi.fn(), assess: vi.fn(), draft: vi.fn(), historyFails: false, evidenceFails: false,
  scan: { due: true, posts_per_scan: 2, scan_interval_hours: 2 },
}));

function thenable(rows: () => Row[], fails = false) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "gte", "order", "limit", "in", "not"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (resolve: (v: unknown) => unknown) => resolve(fails ? { data: null, error: { message: "db" } } : { data: rows(), error: null });
  return chain;
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { signInWithPassword: async () => ({ error: null }) },
    rpc: (name: string, args: unknown) => name === "get_sports_automation_mode" ? Promise.resolve(db.mode) : db.rpc(name, args),
    from: (table: string) => table === "sports_news_items" ? thenable(() => db.items, db.historyFails)
      : table === "content_posts" ? thenable(() => db.posts)
      : table === "content_publish_requests" ? thenable(() => db.requests)
      : table === "publish_deliveries" ? thenable(() => db.deliveries)
      : thenable(() => []),
  }),
}));
vi.mock("@/lib/env", () => ({ getSupabaseEnv: () => ({ url: "http://127.0.0.1:54321", key: "k" }) }));
vi.mock("@/lib/publishing/registry", () => ({ getPublisher: () => ({ render: (s: unknown) => s, publish: vi.fn() }) }));
vi.mock("./photo-snapshot", () => ({ readSportsPhoto: async () => null }));
vi.mock("./source-photo", () => ({ findSourceSportsPhoto: async () => null }));
vi.mock("./licensed-photo", () => ({ findSportsPostPhoto: async () => null }));
vi.mock("./feeds", () => ({ collectSportsNews: db.collect }));
vi.mock("./editor", () => ({ assessSportsNews: db.assess, writeSportsDraft: db.draft }));
vi.mock("./auto-delivery", () => ({ getTemporaryAutoWindow: async () => db.autoWindow, sendTemporarySportsPost: db.send }));
vi.mock("./review-notices", () => ({ readReviewNoticeConfig: () => null, sendReviewNotices: async () => ({}) }));

import { readSportsNewsConfig, runSportsNews } from "./worker";
import { buildEventIdentity } from "./event-identity";

const published = () => Date.now() - 1000;
const article = (title: string, summary: string, url: string) => ({ title, summary, url, publishedAt: published(), categories: "" });
// The reach/importance of a headline is scripted by a leading "[n]" marker so scores are deterministic.
const level = (title: string) => Number(/\[(\d+)\]/.exec(title)?.[1] ?? 5);
const clean = (title: string) => title.replace(/\[\d+\]\s*/, "");

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SPORTS_NEWS_TELEGRAM_DESTINATION_ID;
  delete process.env.SPORTS_NEWS_SOCIAL_TOKENS;
  Object.assign(process.env, {
    SPORTS_NEWS_WORKSPACE_ID: WS, SPORTS_NEWS_PROJECT_ID: PROJECT, SPORTS_NEWS_WORKER_EMAIL: "w@example.com",
    SPORTS_NEWS_WORKER_PASSWORD: "pw", SPORTS_NEWS_MIN_SCORE: "8",
  });
  db.mode = { data: [{ mode: "semi", daily_quota: 40 }], error: null }; db.items = []; db.posts = []; db.requests = []; db.deliveries = []; db.autoWindow = null; db.send.mockResolvedValue(true); db.historyFails = false; db.evidenceFails = false; db.scan = { due: true, posts_per_scan: 2, scan_interval_hours: 2 };
  db.assess.mockImplementation(async (item: { title: string }) => {
    const n = level(item.title);
    return { playerPopularity: n, teamPopularity: n, competitionPopularity: n, eventImportance: n, engagement: n, reason: "r" };
  });
  db.draft.mockImplementation(async (item: { title: string }) => ({ title: `Bài: ${clean(item.title)}`, body: "Nội dung", photoSubject: null, photoNeedsAction: false }));
  db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "begin_sports_scan") return { data: [db.scan], error: null };
    if (name === "finish_sports_scan") return { data: null, error: null };
    if (name === "claim_social_deliveries") return { data: [], error: null };
    if (name === "record_sports_news_event_duplicate") return { data: !db.evidenceFails, error: db.evidenceFails ? { message: "x" } : null };
    if (name === "record_sports_news_event_assessment") return { data: args.p_title ? `post-${String(args.p_source_url)}` : null, error: null };
    throw new Error(`unexpected rpc ${name}`);
  });
});

const recorded = () => db.rpc.mock.calls.filter(([n]) => n === "record_sports_news_event_assessment").map(([, a]) => a as Record<string, unknown>);
const evidence = () => db.rpc.mock.calls.filter(([n]) => n === "record_sports_news_event_duplicate").map(([, a]) => a as Record<string, unknown>);
const feed = (...articles: ReturnType<typeof article>[]) => db.collect.mockResolvedValue({ articles, unavailableSources: [] });

/** Seeds one already-recorded item (with a real post unless `post` is false) into the fake history. */
function seed(title: string, summary: string, url: string, opts: { post?: boolean; archived?: boolean; published?: boolean; delivery?: string; requests?: readonly string[]; identity?: boolean } = {}) {
  const post = opts.post !== false;
  const id = `seed-${url}`;
  const identity = buildEventIdentity({ title, summary, publishedAt: published() });
  db.items.push({
    source_url: url, headline_key: url, event_identity: opts.identity === false ? null : identity,
    post_id: post ? id : null, assessment: { title, publishedAt: new Date(published()).toISOString() }, created_at: new Date().toISOString(),
  });
  if (post) {
    db.posts.push({ id, title: `Bài: ${title}`, body: summary, status: opts.published ? "published" : "draft", archived_at: opts.archived ? new Date().toISOString() : null });
    if (opts.delivery) db.deliveries.push({ post_id: id, status: opts.delivery });
    for (const status of opts.requests ?? ["pending"]) db.requests.push({ post_id: id, status });
  }
}

describe("runSportsNews semantic deduplication", () => {
  it("suppresses a rewrite (reversed team order, other source) of an accepted post and records evidence, before any AI assessment", async () => {
    seed("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/1");
    feed(article("[9] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/1"));
    const report = await runSportsNews(readSportsNewsConfig());
    expect(report).toMatchObject({ semanticDuplicates: 1, assessed: 0, drafted: 0 });
    expect(db.assess).not.toHaveBeenCalled();
    expect(recorded()).toHaveLength(0);
    expect(evidence()[0]).toMatchObject({ p_source_url: "https://b.vn/1" });
    expect(evidence()[0].p_event).toMatchObject({ reasons: expect.arrayContaining([{ code: "same_event_key" }]), evidence: { matchedSourceUrl: "https://a.vn/1" } });
  });

  it("a low-score, unselected or merely discovered earlier item does NOT block a later stronger report", async () => {
    seed("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/low", { post: false });
    feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/strong"));
    const report = await runSportsNews(readSportsNewsConfig());
    expect(report).toMatchObject({ semanticDuplicates: 0, assessed: 1, drafted: 1 });
    expect(recorded()[0]).toMatchObject({ p_source_url: "https://b.vn/strong", p_title: "Bài: Bayern thua sốc Lille 0-1 tại C1" });
  });

  it("same run: the weak report cannot suppress the stronger one, whatever the feed order", async () => {
    const weak = article("[2] Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/weak");
    const strong = article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/strong");
    for (const order of [[weak, strong], [strong, weak]]) {
      db.rpc.mockClear();
      feed(...order);
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report).toMatchObject({ drafted: 1, semanticDuplicates: 1 });
      expect(recorded().filter((r) => r.p_title).map((r) => r.p_source_url)).toEqual(["https://b.vn/strong"]);
      // the weak one is only recorded as a plain below-threshold item (no post), with its evidence kept
      expect(recorded().filter((r) => !r.p_title).map((r) => r.p_source_url)).toEqual(["https://a.vn/weak"]);
      expect(evidence()[0].p_event).toMatchObject({ reasons: expect.arrayContaining([{ code: "same_run_weaker_report" }]) });
    }
  });

  it("archived and fully-rejected accepted posts do not suppress a later report; pending ones do", async () => {
    const title = "Lille hạ Bayern 1-0 ở Champions League";
    for (const [opts, expected] of [
      [{ archived: true }, 1], [{ requests: ["rejected"] }, 1], [{ requests: ["rejected", "pending"] }, 0], [{ requests: ["approved"] }, 0], [{}, 0],
    ] as const) {
      db.items = []; db.posts = []; db.requests = []; db.rpc.mockClear(); db.assess.mockClear();
      seed(title, "Lille thắng Bayern Munich.", "https://a.vn/1", opts);
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/1"));
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report.drafted, JSON.stringify(opts)).toBe(expected);
    }
  });

  it("same teams and date in different known competitions both materialize (Vietnamese + English), payload carries the window keys", async () => {
    seed("Arsenal thắng Chelsea 1-0 ở Premier League", "Arsenal hạ Chelsea.", "https://a.vn/league");
    feed(article("[10] Arsenal beat Chelsea 1-0 in the Europa League", "Arsenal beat Chelsea.", "https://b.com/europe"));
    const report = await runSportsNews(readSportsNewsConfig());
    expect(report).toMatchObject({ semanticDuplicates: 0, drafted: 1 });
    const event = recorded()[0].p_event as { clusterKey: string; clusterWindow: string[]; manualReviewReason?: string };
    expect(event.clusterWindow).toContain(event.clusterKey);
    expect(event.manualReviewReason).toBeUndefined();
  });

  it("a report without a competition next to a known-competition match is kept but manual-review only", async () => {
    seed("Arsenal thắng Chelsea 1-0 ở Premier League", "Arsenal hạ Chelsea.", "https://a.vn/league");
    feed(article("[10] Arsenal thắng Chelsea 1-0", "Arsenal hạ Chelsea.", "https://b.vn/bare"));
    const report = await runSportsNews(readSportsNewsConfig());
    expect(report).toMatchObject({ semanticDuplicates: 0, drafted: 1 });
    expect(recorded()[0].p_event).toMatchObject({ manualReviewReason: "uncertain_facts" });
  });

  it("different players' injuries and transfers at one club are both processed", async () => {
    seed("Bukayo Saka chấn thương, vắng mặt hai tuần", "Arsenal xác nhận Saka chấn thương đùi.", "https://a.vn/saka");
    feed(
      article("[10] Martin Odegaard chấn thương cổ chân, Arsenal lo lắng", "Arsenal mất Odegaard.", "https://b.vn/ode"),
      article("[9] Arsenal chính thức ký Erling Haaland", "Erling Haaland gia nhập Arsenal.", "https://b.vn/haa"),
    );
    const report = await runSportsNews(readSportsNewsConfig());
    expect(report).toMatchObject({ semanticDuplicates: 0, drafted: 2 });
  });

  it("sparse identities fail open: normal scoring, manual review path, no suppression", async () => {
    seed("Arsenal lo lắng vì chấn thương", "Một ngôi sao của Arsenal chấn thương.", "https://a.vn/vague");
    feed(article("[10] Arsenal lo lắng vì chấn thương", "Một ngôi sao khác của Arsenal chấn thương.", "https://b.vn/vague"));
    const report = await runSportsNews(readSportsNewsConfig());
    expect(report).toMatchObject({ semanticDuplicates: 0, drafted: 1 });
    expect(recorded()[0].p_event).toMatchObject({ specific: false });
  });

  it("keeps meaningful follow-ups (rumor → official, changed score) linked and counted", async () => {
    seed("Chelsea quan tâm Erling Haaland", "Tin đồn chuyển nhượng Erling Haaland.", "https://a.vn/rumor");
    seed("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/match");
    feed(
      article("[10] Chelsea chính thức ký Erling Haaland", "Chuyển nhượng hoàn tất, Erling Haaland gia nhập Chelsea.", "https://b.vn/official"),
      article("[9] Lille hạ Bayern 2-1 sau hiệp phụ", "Lille thắng Bayern ở Champions League.", "https://b.vn/score"),
    );
    const report = await runSportsNews(readSportsNewsConfig());
    expect(report).toMatchObject({ followUps: 2, semanticDuplicates: 0, drafted: 2 });
    expect(recorded().map((r) => (r.p_event as { decision: string }).decision)).toEqual(["follow_up", "follow_up"]);
  });

  it("historical rows without a stored identity are conservatively derived from headline and post body", async () => {
    seed("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/old", { identity: false });
    feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/1"));
    expect(await runSportsNews(readSportsNewsConfig())).toMatchObject({ semanticDuplicates: 1, drafted: 0 });
    expect(evidence()[0].p_event).toMatchObject({ evidence: { matchedOrigin: "derived" } });
    // an old row too sparse to derive anything specific never suppresses
    db.items = []; db.posts = []; db.requests = []; db.rpc.mockClear();
    seed("Tin nóng bóng đá hôm nay", "Nhiều tin.", "https://a.vn/vague", { identity: false });
    feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/2"));
    expect(await runSportsNews(readSportsNewsConfig())).toMatchObject({ semanticDuplicates: 0, drafted: 1 });
  });

  it("URL and headline deduplication keep precedence over semantics (no event work at all)", async () => {
    seed("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/1");
    db.items[0].headline_key = "dup";
    feed(article("[10] Lille hạ Bayern 1-0 ở Champions League", "x", "https://a.vn/1"));
    const report = await runSportsNews(readSportsNewsConfig());
    expect(report).toMatchObject({ semanticDuplicates: 0, assessed: 0 });
    expect(evidence()).toHaveLength(0);
  });

  it("evidence write failures are reported, never swallowed", async () => {
    seed("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/1");
    db.evidenceFails = true;
    feed(article("[9] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/1"));
    expect(await runSportsNews(readSportsNewsConfig())).toMatchObject({ eventEvidenceFailures: 1, itemFailures: 1 });
  });

  it("a failed history read aborts the run instead of silently skipping deduplication", async () => {
    seed("Lille hạ Bayern 1-0 ở Champions League", "x", "https://a.vn/1");
    db.historyFails = true;
    feed(article("[9] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich.", "https://b.vn/1"));
    await expect(runSportsNews(readSportsNewsConfig())).rejects.toThrow("sports_news_history_failed");
  });
  it("a published or delivered post keeps blocking after archive; an unsent archived post is reconsidered", async () => {
    const title = "Lille hạ Bayern 1-0 ở Champions League";
    for (const [opts, expected] of [
      [{ archived: true, published: true }, 0], [{ archived: true, delivery: "succeeded" }, 0],
      [{ archived: true, delivery: "queued" }, 0], [{ archived: true, delivery: "sending" }, 0],
      [{ archived: true, delivery: "failed" }, 1], [{ archived: true, delivery: "cancelled" }, 1],
      [{ archived: true, requests: ["rejected"] }, 1], [{ published: true }, 0],
    ] as const) {
      db.items = []; db.posts = []; db.requests = []; db.deliveries = []; db.rpc.mockClear();
      seed(title, "Lille thắng Bayern Munich.", "https://a.vn/1", opts);
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/1"));
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report.drafted, JSON.stringify(opts)).toBe(expected);
    }
  });

  describe("manual review only (auto-publish window enabled)", () => {
    const TELEGRAM = "44444444-4444-4444-8444-444444444444";
    beforeEach(() => {
      process.env.SPORTS_NEWS_TELEGRAM_DESTINATION_ID = TELEGRAM;
      process.env.SPORTS_NEWS_SOCIAL_TOKENS = JSON.stringify({ [TELEGRAM]: "token" });
      db.autoWindow = { id: "w", starts_at: new Date(0).toISOString(), ends_at: new Date(Date.now() + 3600_000).toISOString() };
    });
    const sentIds = () => db.send.mock.calls.map(([, , , draft]) => (draft as { id: string }).id);

    it("regular eligible reports are still auto-published", async () => {
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/regular"));
      const report = await runSportsNews(readSportsNewsConfig());
      expect(sentIds()).toEqual(["post-https://b.vn/regular"]);
      expect(report).toMatchObject({ drafted: 1, autoPublished: 1 });
    });

    it("unresolved identities, follow-ups and reconsidered archived/rejected events are never sent", async () => {
      seed("Chelsea quan tâm Erling Haaland", "Tin đồn chuyển nhượng Erling Haaland.", "https://a.vn/rumor");
      seed("Arsenal thắng Chelsea 1-0 ở Ngoại hạng Anh", "Arsenal hạ Chelsea.", "https://a.vn/old", { archived: true });
      feed(
        article("[10] Chelsea chính thức ký Erling Haaland", "Chuyển nhượng hoàn tất, Erling Haaland gia nhập Chelsea.", "https://b.vn/followup"),
        article("[8] Tin nóng bóng đá hôm nay", "Nhiều diễn biến.", "https://b.vn/vague"),
        article("[9] Chelsea thua Arsenal 0-1 tại Premier League", "Arsenal chiến thắng Chelsea.", "https://b.vn/reconsidered"),
        article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/regular"),
      );
      db.scan = { due: true, posts_per_scan: 3, scan_interval_hours: 2 };
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report.drafted).toBe(3); // posts-per-scan cap (3 configured here); the weakest (unresolved) report is not drafted
      expect(sentIds()).toEqual(["post-https://b.vn/regular"]);
      const reasons = Object.fromEntries(recorded().map((r) => [r.p_source_url, (r.p_event as { manualReviewReason?: string }).manualReviewReason]));
      expect(reasons).toMatchObject({
        "https://b.vn/followup": "follow_up", "https://b.vn/reconsidered": "reconsidered",
      });
      expect(reasons["https://b.vn/vague"]).toBeUndefined();
      expect(reasons["https://b.vn/regular"]).toBeUndefined();
    });

    it("a same-status report that adds a material fact is a manual follow-up, not an auto-published item", async () => {
      seed("Bukayo Saka chấn thương, Arsenal lo lắng", "Saka bị chấn thương đùi.", "https://a.vn/saka");
      feed(article("[10] Bukayo Saka chấn thương, nghỉ 6 tuần", "Arsenal cho biết Saka bị chấn thương và sẽ nghỉ 6 tuần.", "https://b.vn/saka6"));
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report).toMatchObject({ followUps: 1, semanticDuplicates: 0, drafted: 1, autoPublished: 0 });
      expect(sentIds()).toEqual([]);
      expect(recorded()[0].p_event).toMatchObject({ decision: "follow_up", reasons: expect.arrayContaining([expect.objectContaining({ code: "new_material_facts" })]) });
    });

    it("a published+archived event is not reported again, so nothing is sent twice", async () => {
      seed("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/1", { archived: true, published: true });
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/1"));
      expect(await runSportsNews(readSportsNewsConfig())).toMatchObject({ drafted: 0, semanticDuplicates: 1, autoPublished: 0 });
      expect(db.send).not.toHaveBeenCalled();
    });
  });

  describe("FN08 automation modes", () => {
    const TELEGRAM = "44444444-4444-4444-8444-444444444444";
    const setMode = (mode: string) => { db.mode = { data: [{ mode, daily_quota: 40 }], error: null }; };
    const rpcNames = () => db.rpc.mock.calls.map(([n]) => n);

    it("Off makes zero RSS, AI, draft, record, delivery or notice calls", async () => {
      setMode("off");
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/off"));
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report).toMatchObject({ mode: "off", skipped: "automation_off", drafted: 0, assessed: 0, autoPublished: 0 });
      expect(db.collect).not.toHaveBeenCalled();
      expect(db.assess).not.toHaveBeenCalled();
      expect(db.draft).not.toHaveBeenCalled();
      expect(db.send).not.toHaveBeenCalled();
      // FN10: the only database call allowed while Off is the history-retention housekeeping.
      expect(db.rpc.mock.calls.map(([n]) => n)).toEqual(["purge_sports_automation_history"]);
    });

    it("FN09: a scan that is not due does no RSS, AI or draft work and only runs delivery-only", async () => {
      db.scan = { due: false, posts_per_scan: 2, scan_interval_hours: 4 };
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/early"));
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report).toMatchObject({ skipped: "scan_not_due", drafted: 0, assessed: 0 });
      expect(db.collect).not.toHaveBeenCalled();
      expect(db.assess).not.toHaveBeenCalled();
      expect(db.draft).not.toHaveBeenCalled();
      expect(rpcNames()).not.toContain("record_sports_news_event_assessment");
    });

    it("FN09-QC-C: every feed unavailable is a failed scan (retryable); an empty or partial scan is a success", async () => {
      const finished = () => db.rpc.mock.calls.filter(([n]) => n === "finish_sports_scan").map(([, a]) => (a as { p_ok: boolean }).p_ok);
      const names = Array.from({ length: 100 }, (_, i) => `f${i}`);
      db.collect.mockResolvedValue({ articles: [], unavailableSources: names });
      expect(await runSportsNews(readSportsNewsConfig())).toMatchObject({ scanFailed: true, drafted: 0 });
      expect(finished()).toEqual([false]);
      expect(db.assess).not.toHaveBeenCalled();
      db.rpc.mockClear();
      db.collect.mockResolvedValue({ articles: [], unavailableSources: [] });
      expect(await runSportsNews(readSportsNewsConfig())).toMatchObject({ scanFailed: false });
      expect(finished()).toEqual([true]);
      db.rpc.mockClear();
      db.collect.mockResolvedValue({ articles: [], unavailableSources: names.slice(0, 1) });
      expect(await runSportsNews(readSportsNewsConfig())).toMatchObject({ scanFailed: false });
      expect(finished()).toEqual([true]);
    });

    it("FN09-QC-C: a throwing collection marks the scan failed and still fails the run", async () => {
      db.collect.mockRejectedValue(new Error("network"));
      await expect(runSportsNews(readSportsNewsConfig())).rejects.toThrow("network");
      expect(db.rpc.mock.calls.filter(([n]) => n === "finish_sports_scan").map(([, a]) => (a as { p_ok: boolean }).p_ok)).toEqual([false]);
      expect(db.assess).not.toHaveBeenCalled();
    });

    it("FN09: a failing scan gate fails closed (no RSS/AI work)", async () => {
      db.rpc.mockImplementation(async (name: string) => name === "begin_sports_scan" ? { data: null, error: { message: "x" } } : { data: [], error: null });
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/gate"));
      await expect(runSportsNews(readSportsNewsConfig())).rejects.toThrow("sports_news_scan_gate_failed");
      expect(db.collect).not.toHaveBeenCalled();
      expect(db.assess).not.toHaveBeenCalled();
    });

    it("FN09: posts per scan caps distinct posts across all feeds (default 2, configurable)", async () => {
      const stories = ["Real Madrid", "Barcelona", "Liverpool", "Arsenal", "Juventus"].map((team, i) =>
        article(`[10] ${team} thắng ${i}-0 tại giải số ${i}`, `${team} giành chiến thắng thuyết phục lượt ${i}.`, `https://f${i}.vn/${i}`));
      for (const [limit, expected] of [[2, 2], [1, 1], [4, 4]] as const) {
        db.rpc.mockClear();
        db.scan = { due: true, posts_per_scan: limit, scan_interval_hours: 2 };
        feed(...stories);
        await runSportsNews(readSportsNewsConfig());
        expect(recorded().filter((r) => r.p_title)).toHaveLength(expected);
      }
    });

    it("an unreadable mode fails closed to Off", async () => {
      db.mode = { data: null, error: { message: "db" } };
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/err"));
      expect(await runSportsNews(readSportsNewsConfig())).toMatchObject({ skipped: "automation_off" });
      expect(db.assess).not.toHaveBeenCalled();
    });

    it("Off arriving after the RSS read stops before the first AI call (safe checkpoint)", async () => {
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/mid"));
      let reads = 0;
      Object.defineProperty(db, "mode", { configurable: true, get: () => ({ data: [{ mode: ++reads > 1 ? "off" : "semi", daily_quota: 40 }], error: null }), set: () => undefined });
      try {
        const report = await runSportsNews(readSportsNewsConfig());
        expect(report).toMatchObject({ mode: "stopped", skipped: "automation_off", drafted: 0 });
        expect(db.assess).not.toHaveBeenCalled();
        expect(db.draft).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(db, "mode", { configurable: true, writable: true, value: { data: [{ mode: "semi", daily_quota: 40 }], error: null } });
      }
    });

    it("Off arriving after assessment stops before any draft call and records nothing", async () => {
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/late"));
      let reads = 0;
      Object.defineProperty(db, "mode", { configurable: true, get: () => ({ data: [{ mode: ++reads > 2 ? "off" : "semi", daily_quota: 40 }], error: null }), set: () => undefined });
      try {
        const report = await runSportsNews(readSportsNewsConfig());
        expect(report).toMatchObject({ mode: "stopped", drafted: 0, itemFailures: 0 });
        expect(db.draft).not.toHaveBeenCalled();
        expect(rpcNames()).not.toContain("record_sports_news_event_assessment");
      } finally {
        Object.defineProperty(db, "mode", { configurable: true, writable: true, value: { data: [{ mode: "semi", daily_quota: 40 }], error: null } });
      }
    });

    it("Semi never auto-publishes: no window is consulted for sending", async () => {
      process.env.SPORTS_NEWS_TELEGRAM_DESTINATION_ID = TELEGRAM;
      process.env.SPORTS_NEWS_SOCIAL_TOKENS = JSON.stringify({ [TELEGRAM]: "token" });
      feed(article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/semi"));
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report).toMatchObject({ mode: "on", drafted: 1, autoPublished: 0 });
      expect(db.send).not.toHaveBeenCalled();
    });

    it("persistent Auto also sends unresolved, follow-up and reconsidered drafts (confirmed duplicates stay blocked)", async () => {
      process.env.SPORTS_NEWS_TELEGRAM_DESTINATION_ID = TELEGRAM;
      process.env.SPORTS_NEWS_SOCIAL_TOKENS = JSON.stringify({ [TELEGRAM]: "token" });
      setMode("auto");
      db.autoWindow = { id: "w", starts_at: new Date(0).toISOString(), ends_at: null, persistent: true };
      seed("Chelsea quan tâm Erling Haaland", "Tin đồn chuyển nhượng Erling Haaland.", "https://a.vn/rumor");
      seed("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/dup");
      feed(
        article("[10] Chelsea chính thức ký Erling Haaland", "Chuyển nhượng hoàn tất, Erling Haaland gia nhập Chelsea.", "https://b.vn/followup"),
        article("[8] Tin nóng bóng đá hôm nay", "Nhiều diễn biến.", "https://b.vn/vague"),
        article("[8] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/dup2"),
      );
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report).toMatchObject({ drafted: 2, semanticDuplicates: 1, autoPublished: 2, persistentAuto: true });
      expect(db.send.mock.calls.map(([, , , draft]) => (draft as { id: string }).id).sort())
        .toEqual(["post-https://b.vn/followup", "post-https://b.vn/vague"]);
    });
  });

  it("same-run follow-up: result scoring below its preview is linked, whatever the order, and is manual only", async () => {
    const preview = article("[10] Nhận định Lille vs Bayern tại Champions League", "Soi kèo Lille Bayern Munich.", "https://a.vn/preview");
    const result = article("[9] Lille hạ Bayern 2-1 tại Champions League", "Lille thắng Bayern Munich.", "https://b.vn/result");
    for (const order of [[preview, result], [result, preview]]) {
      db.rpc.mockClear();
      feed(...order);
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report).toMatchObject({ drafted: 2 });
      const byUrl = Object.fromEntries(recorded().map((r) => [r.p_source_url, r.p_event as { decision: string; manualReviewReason?: string }]));
      expect(byUrl["https://b.vn/result"]).toMatchObject({ decision: "follow_up", manualReviewReason: "follow_up" });
    }
  });

  it("two distinct events in one run are both materialized (no false merge)", async () => {
    feed(
      article("[10] Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/1"),
      article("[9] Arsenal thắng Chelsea 2-1 ở Premier League", "Arsenal hạ Chelsea.", "https://a.vn/2"),
    );
    expect(await runSportsNews(readSportsNewsConfig())).toMatchObject({ drafted: 2, semanticDuplicates: 0 });
  });

  describe("failures and unselected reports leave the event eligible", () => {
    const strong = article("[10] Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã. Champions League.", "https://b.vn/strong");
    const weaker = article("[9] Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://a.vn/weaker");

    it("if the top draft fails, the weaker report of the same event is used within the draft budget", async () => {
      db.draft.mockImplementationOnce(async () => { throw new Error("ai down"); });
      feed(strong, weaker);
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report).toMatchObject({ drafted: 1, itemFailures: 1 });
      expect(recorded().filter((r) => r.p_title).map((r) => r.p_source_url)).toEqual(["https://a.vn/weaker"]);
      expect(db.draft).toHaveBeenCalledTimes(2);
      expect(evidence()).toHaveLength(0); // no skip evidence persisted as final
    });

    it("if every attempt fails, no skip evidence is stored and nothing blocks the next run", async () => {
      db.draft.mockRejectedValue(new Error("ai down"));
      feed(strong, weaker);
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report).toMatchObject({ drafted: 0, semanticDuplicates: 0, eventEvidenceFailures: 0 });
      expect(evidence()).toHaveLength(0);
      expect(recorded().filter((r) => r.p_title)).toHaveLength(0);
    });

    it("a failed record call also falls back, and a database-rejected duplicate does not", async () => {
      let calls = 0;
      db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
        if (name === "begin_sports_scan") return { data: [db.scan], error: null };
        if (name === "finish_sports_scan") return { data: null, error: null };
        if (name === "claim_social_deliveries") return { data: [], error: null };
        if (name === "record_sports_news_event_duplicate") return { data: true, error: null };
        calls += 1;
        if (calls === 1) throw new Error("db down");
        return { data: args.p_title ? `post-${String(args.p_source_url)}` : null, error: null };
      });
      feed(strong, weaker);
      expect(await runSportsNews(readSportsNewsConfig())).toMatchObject({ drafted: 1 });
      db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
        name === "begin_sports_scan" ? { data: [db.scan], error: null } : name === "claim_social_deliveries" ? { data: [], error: null } : name === "record_sports_news_event_duplicate" ? { data: true, error: null }
          : { data: args.p_title ? null : null, error: null });
      db.draft.mockClear();
      feed(strong, weaker);
      await runSportsNews(readSportsNewsConfig());
      expect(db.draft).toHaveBeenCalledTimes(1); // null = event already exists: no fallback
    });

    it("a weaker report is persisted as a skip only after its event actually became a post", async () => {
      feed(strong, weaker);
      const report = await runSportsNews(readSportsNewsConfig());
      expect(report).toMatchObject({ drafted: 1, semanticDuplicates: 1 });
      expect(evidence()).toHaveLength(1);
    });
  });
});
