import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  items: [] as Row[], posts: [] as Row[], requests: [] as Row[],
  rpc: vi.fn(), collect: vi.fn(), assess: vi.fn(), draft: vi.fn(), historyFails: false, evidenceFails: false,
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
    rpc: db.rpc,
    from: (table: string) => table === "sports_news_items" ? thenable(() => db.items, db.historyFails)
      : table === "content_posts" ? thenable(() => db.posts)
      : table === "content_publish_requests" ? thenable(() => db.requests)
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
vi.mock("./auto-delivery", () => ({ getTemporaryAutoWindow: async () => null, sendTemporarySportsPost: vi.fn() }));
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
  Object.assign(process.env, {
    SPORTS_NEWS_WORKSPACE_ID: WS, SPORTS_NEWS_PROJECT_ID: PROJECT, SPORTS_NEWS_WORKER_EMAIL: "w@example.com",
    SPORTS_NEWS_WORKER_PASSWORD: "pw", SPORTS_NEWS_MIN_SCORE: "8",
  });
  db.items = []; db.posts = []; db.requests = []; db.historyFails = false; db.evidenceFails = false;
  db.assess.mockImplementation(async (item: { title: string }) => {
    const n = level(item.title);
    return { playerPopularity: n, teamPopularity: n, competitionPopularity: n, eventImportance: n, reason: "r" };
  });
  db.draft.mockImplementation(async (item: { title: string }) => ({ title: `Bài: ${clean(item.title)}`, body: "Nội dung", photoSubject: null, photoNeedsAction: false }));
  db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
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
function seed(title: string, summary: string, url: string, opts: { post?: boolean; archived?: boolean; requests?: readonly string[]; identity?: boolean } = {}) {
  const post = opts.post !== false;
  const id = `seed-${url}`;
  const identity = buildEventIdentity({ title, summary, publishedAt: published() });
  db.items.push({
    source_url: url, headline_key: url, event_identity: opts.identity === false ? null : identity,
    post_id: post ? id : null, assessment: { title, publishedAt: new Date(published()).toISOString() }, created_at: new Date().toISOString(),
  });
  if (post) {
    db.posts.push({ id, title: `Bài: ${title}`, body: summary, archived_at: opts.archived ? new Date().toISOString() : null });
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
});
