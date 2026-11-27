import { describe, expect, it } from "vitest";

import { buildEventIdentity, buildEventPayload, classifyEvent, parseStoredIdentity, type KnownEvent } from "./event-identity";

const at = (iso: string) => Date.parse(iso);
const item = (title: string, summary: string, iso = "2026-11-27T10:00:00+07:00") =>
  ({ title, summary, publishedAt: at(iso) });
const known = (title: string, summary: string, url: string, iso?: string): KnownEvent =>
  ({ identity: buildEventIdentity(item(title, summary, iso)), sourceUrl: url, title });

describe("event identity", () => {
  it("is deterministic and extracts participants, competition, type and date", () => {
    const a = buildEventIdentity(item("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich ở vòng bảng Cup C1."));
    const b = buildEventIdentity(item("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich ở vòng bảng Cup C1."));
    expect(a).toEqual(b);
    expect(a.participants).toEqual(["bayern", "lille"]);
    expect(a.competition).toBe("champions-league");
    expect(a.type).toBe("match_result");
    expect(a.scores).toEqual(["0-1"]);
    expect(a.date).toBe("2026-11-27");
    expect(a.eventKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips through storage and rejects malformed values", () => {
    const id = buildEventIdentity(item("Real Madrid thắng Barcelona 2-1", "Kết quả Siêu kinh điển."));
    expect(parseStoredIdentity(JSON.parse(JSON.stringify(id)))).toEqual(id);
    expect(parseStoredIdentity({ ...id, eventKey: "x" })).toBeNull();
    expect(parseStoredIdentity(null)).toBeNull();
    expect(parseStoredIdentity([])).toBeNull();
  });
});

describe("semantic deduplication fixtures", () => {
  const original = known("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich ở Cup C1.", "https://tuoitre.vn/a");

  it("treats a differently worded report of the same match as a duplicate", () => {
    const rewrite = buildEventIdentity(item("Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã trước Lille. Champions League."));
    const result = classifyEvent(rewrite, [original]);
    expect(result.decision).toBe("duplicate");
    expect(result.reasons.map((r) => r.code)).toContain("same_event_key");
    const looser = buildEventIdentity(item("Bayern gục ngã trước Lille", "Bayern Munich thất bại ở Champions League."));
    const loose = classifyEvent(looser, [original]);
    expect(loose.decision).toBe("duplicate");
    expect(loose.reasons.map((r) => r.code)).toContain("participants_overlap");
  });

  it("treats a different score for the same fixture as a meaningful follow-up", () => {
    const update = buildEventIdentity(item("Lille hạ Bayern 2-1 sau hiệp phụ", "Lille thắng Bayern ở Champions League."));
    const result = classifyEvent(update, [original]);
    expect(result.decision).toBe("follow_up");
    expect(result.reasons.map((r) => r.code)).toContain("score_changed");
  });

  it("treats a preview followed by a result (type change) as a follow-up", () => {
    const preview = known("Nhận định Lille vs Bayern", "Nhận định trước trận ở Champions League.", "https://x/p");
    const result = classifyEvent(original.identity, [preview]);
    expect(result.decision).toBe("follow_up");
    expect(result.reasons.map((r) => r.code)).toContain("event_type_changed");
  });

  it("treats rumor → official transfer as a follow-up but official → rumor as a duplicate", () => {
    const rumor = known("Chelsea quan tâm Haaland", "Tin đồn chuyển nhượng Erling Haaland.", "https://x/r");
    const official = buildEventIdentity(item("Chelsea chính thức ký Haaland", "Chuyển nhượng hoàn tất, Erling Haaland gia nhập Chelsea."));
    expect(classifyEvent(official, [rumor]).decision).toBe("follow_up");
    const official2 = known("Chelsea chính thức ký Haaland", "Chuyển nhượng hoàn tất, Erling Haaland gia nhập Chelsea.", "https://x/o");
    const laterRumor = buildEventIdentity(item("Chelsea có thể ký Haaland", "Tin đồn chuyển nhượng Erling Haaland sang Chelsea."));
    expect(classifyEvent(laterRumor, [official2]).decision).toBe("duplicate");
  });

  it("does not merge different matches, different days or different competitions", () => {
    const other = buildEventIdentity(item("Real Madrid thắng Barcelona 2-1", "Kết quả La Liga."));
    expect(classifyEvent(other, [original]).decision).toBe("new");
    const nextWeek = buildEventIdentity(item("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern.", "2026-12-05T10:00:00+07:00"));
    expect(classifyEvent(nextWeek, [original]).decision).toBe("new");
    const league = buildEventIdentity(item("Lille hạ Bayern 1-0 ở giải giao hữu", "Lille thắng Bayern. Premier League.", "2026-11-27T10:00:00+07:00"));
    expect(classifyEvent(league, [original]).decision).toBe("new");
  });

  it("returns the exact same event key as an exact duplicate", () => {
    expect(classifyEvent(original.identity, [original])).toMatchObject({ decision: "duplicate", reasons: [{ code: "same_event_key" }] });
  });

  it("is order independent and ignores identities from another version", () => {
    const stale = { ...original, identity: { ...original.identity, version: "event-v0" as never } };
    expect(classifyEvent(original.identity, [stale]).decision).toBe("new");
  });

  it("does not treat clock times or unrelated numbers as scores", () => {
    expect(buildEventIdentity(item("Man City họp báo 20-30 phút", "Man City họp báo.")).scores).toEqual([]);
  });
});

describe("event payload", () => {
  it("carries decision, structured reasons and evidence of the matched event", () => {
    const old = known("Chelsea quan tâm Haaland", "Tin đồn chuyển nhượng Erling Haaland.", "https://x/r");
    const next = buildEventIdentity(item("Chelsea chính thức ký Haaland", "Chuyển nhượng hoàn tất, Erling Haaland gia nhập Chelsea."));
    const payload = buildEventPayload(next, classifyEvent(next, [old]));
    expect(payload).toMatchObject({
      decision: "follow_up", eventKey: next.eventKey, clusterKey: next.clusterKey,
      matchedEventKey: old.identity.eventKey,
      reasons: expect.arrayContaining([{ code: "status_upgraded", detail: "rumor->official" }]),
      evidence: { matchedSourceUrl: "https://x/r", candidateStatus: "official", matchedStatus: "rumor" },
    });
    const fresh = buildEventPayload(next, classifyEvent(next, []));
    expect(fresh).toMatchObject({ decision: "new", reasons: [{ code: "no_matching_event" }] });
    expect(fresh).not.toHaveProperty("matchedEventKey");
  });
});
