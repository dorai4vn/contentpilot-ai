import { describe, expect, it } from "vitest";

import { buildEventIdentity, buildEventPayload, classifyEvent, parseStoredIdentity, type KnownEvent } from "./event-identity";

const at = (iso: string) => Date.parse(iso);
const item = (title: string, summary: string, iso = "2026-11-27T10:00:00+07:00") => ({ title, summary, publishedAt: at(iso) });
const known = (title: string, summary: string, url: string, iso?: string): KnownEvent =>
  ({ identity: buildEventIdentity(item(title, summary, iso)), sourceUrl: url, title, origin: "stored" });
const verdict = (title: string, summary: string, history: KnownEvent[], iso?: string) =>
  classifyEvent(buildEventIdentity(item(title, summary, iso)), history);
const codes = (result: ReturnType<typeof classifyEvent>) => result.reasons.map((r) => r.code);

describe("event identity", () => {
  it("is deterministic and extracts teams, competition, type and date for a match", () => {
    const a = buildEventIdentity(item("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich ở vòng bảng Cup C1."));
    expect(a).toEqual(buildEventIdentity(item("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich ở vòng bảng Cup C1.")));
    expect(a).toMatchObject({ subjectKind: "match", teams: ["bayern", "lille"], competition: "champions-league", type: "match_result", scores: ["0-1"], date: "2026-11-27" });
    expect(a.eventKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips through storage and rejects malformed values", () => {
    const id = buildEventIdentity(item("Real Madrid thắng Barcelona 2-1", "Kết quả Siêu kinh điển."));
    expect(parseStoredIdentity(JSON.parse(JSON.stringify(id)))).toEqual(id);
    expect(parseStoredIdentity({ ...id, eventKey: "x" })).toBeNull();
    expect(parseStoredIdentity({ ...id, subjectKind: "other" })).toBeNull();
    expect(parseStoredIdentity({ ...id, version: "event-v1" })).toBeNull();
    expect(parseStoredIdentity(null)).toBeNull();
    expect(parseStoredIdentity([])).toBeNull();
  });

  it("does not read the Vietnamese month 'tháng' as a win, nor a bare 'real'/'mu' as a club", () => {
    expect(buildEventIdentity(item("Man City họp báo tháng 11", "Man City.")).subjectKind).toBe("unresolved");
    expect(buildEventIdentity(item("Real chance cho Arsenal thắng Chelsea", "Arsenal beat Chelsea.")).teams).toEqual(["arsenal", "chelsea"]);
  });

  it("does not treat clock times or unrelated numbers as scores", () => {
    expect(buildEventIdentity(item("Man City họp báo 20-30 phút", "Man City họp báo.")).scores).toEqual([]);
  });
});

describe("true duplicates are still suppressed", () => {
  const original = known("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich ở Cup C1.", "https://tuoitre.vn/a");

  it("same match from another source with different wording and reversed team order", () => {
    const rewrite = verdict("Bayern thua sốc Lille 0-1 tại C1", "Bayern Munich gục ngã trước Lille. Champions League.", [original]);
    expect(rewrite.decision).toBe("duplicate");
    expect(codes(rewrite)).toContain("same_event_key");
    const looser = verdict("Bayern gục ngã trước Lille", "Bayern Munich thất bại ở Champions League.", [original]);
    expect(looser.decision).toBe("duplicate");
    expect(codes(looser)).toEqual(expect.arrayContaining(["same_team_pair", "same_match_report"]));
  });

  it("English wording with a different headline and the same fixture", () => {
    const en = known("Manchester City beat Arsenal 2-1", "Man City win at the Etihad.", "https://bbc.com/a");
    expect(verdict("Arsenal lose 1-2 to Manchester City", "Arsenal defeated by Man City.", [en]).decision).toBe("duplicate");
  });

  it("the same transfer reported by two outlets, and the same injury", () => {
    const transfer = known("Chelsea chính thức ký Marcus Rashford", "Chuyển nhượng hoàn tất, Marcus Rashford gia nhập Chelsea.", "https://x/t");
    expect(verdict("Rashford gia nhập Chelsea, hoàn tất chuyển nhượng chính thức", "Marcus Rashford ký hợp đồng với Chelsea.", [transfer]).decision).toBe("duplicate");
    const injury = known("Bukayo Saka chấn thương, vắng mặt hai tuần", "Arsenal xác nhận tin buồn.", "https://x/i");
    expect(verdict("Arsenal mất Bukayo Saka vì chấn thương", "Bukayo Saka chấn thương đùi.", [injury]).decision).toBe("duplicate");
  });
});

describe("false positives are avoided", () => {
  it("different players' injuries at one club never collapse", () => {
    const saka = known("Bukayo Saka chấn thương, vắng mặt hai tuần", "Arsenal xác nhận Saka chấn thương đùi.", "https://x/saka");
    const result = verdict("Martin Odegaard chấn thương cổ chân, Arsenal lo lắng", "Arsenal mất Odegaard.", [saka]);
    expect(result.decision).toBe("new");
  });

  it("different players' transfers to the same club never collapse", () => {
    const first = known("Chelsea chính thức ký Marcus Rashford", "Marcus Rashford gia nhập Chelsea.", "https://x/1");
    expect(verdict("Chelsea chính thức ký Erling Haaland", "Erling Haaland gia nhập Chelsea.", [first]).decision).toBe("new");
  });

  it("the same player at two different destination clubs is not the same transfer", () => {
    const first = known("Chelsea quan tâm Marcus Rashford", "Tin đồn Marcus Rashford.", "https://x/1");
    expect(verdict("Barcelona quan tâm Marcus Rashford", "Tin đồn Marcus Rashford.", [first]).decision).toBe("new");
  });

  it("same club/date/type with an unnamed player (sparse identity) fails open, never matches", () => {
    const saka = known("Bukayo Saka chấn thương, vắng mặt hai tuần", "Arsenal xác nhận.", "https://x/saka");
    const vague = buildEventIdentity(item("Arsenal lo lắng vì chấn thương", "Một ngôi sao của Arsenal chấn thương."));
    expect(vague.subjectKind).toBe("unresolved");
    expect(classifyEvent(vague, [saka])).toMatchObject({ decision: "new", reasons: [{ code: "identity_not_specific" }] });
    // and an unresolved known event never blocks a specific candidate
    expect(classifyEvent(saka.identity, [{ identity: vague, sourceUrl: "https://x/v" }]).decision).toBe("new");
  });

  it("generic starter words are not treated as a person", () => {
    const a = known("Sao Man United chấn thương nặng", "Man United lo lắng.", "https://x/a");
    const b = buildEventIdentity(item("Sao Man United khác chấn thương", "Man United thêm một trường hợp."));
    expect(a.identity.subjectKind).toBe("unresolved");
    expect(classifyEvent(b, [a]).decision).toBe("new");
  });

  it("unrelated matches, other days and mixed/roundup headlines do not merge", () => {
    const original = known("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich.", "https://tuoitre.vn/a");
    expect(verdict("Real Madrid thắng Barcelona 2-1", "Kết quả La Liga.", [original]).decision).toBe("new");
    expect(verdict("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern.", [original], "2026-12-05T10:00:00+07:00").decision).toBe("new");
    expect(verdict("Arsenal, Chelsea và Liverpool cùng thắng", "Vòng đấu Premier League.", [original]).decision).toBe("new");
    expect(buildEventIdentity(item("Rashford chấn thương, Man United thua 0-1 Lille", "Man United thua.")).unresolvedReason).toBe("mixed_event_types");
  });

  it("a single-word name at the start of a headline needs support from the summary", () => {
    expect(buildEventIdentity(item("Haaland chấn thương", "Tin mới nhất.")).subjectKind).toBe("unresolved");
    expect(buildEventIdentity(item("Haaland chấn thương", "Erling Haaland chấn thương cơ đùi.")).people).toEqual(["haaland"]);
  });

  it("a bare surname stands for a full name only with the same club and a unique full name", () => {
    const full = known("Marcus Rashford chấn thương, Man United lo lắng", "Man United xác nhận.", "https://x/f");
    expect(verdict("Man United mất Rashford vì chấn thương", "Rashford chấn thương dây chằng.", [full])).toMatchObject({ decision: "duplicate", reasons: expect.arrayContaining([{ code: "same_person_alias", detail: "rashford" }]) });
    // different club evidence: no alias
    expect(verdict("Arsenal mất Rashford vì chấn thương", "Rashford chấn thương dây chằng.", [full]).decision).toBe("new");
    // two candidate full names with that surname: refuse
    const twin = known("Bruno Fernandes chấn thương, Man United lo lắng", "Man United xác nhận.", "https://x/b");
    const other = known("Mason Fernandes chấn thương, Man United lo lắng", "Man United xác nhận.", "https://x/m");
    expect(verdict("Man United mất Fernandes vì chấn thương", "Fernandes chấn thương.", [twin]).decision).toBe("duplicate");
    expect(verdict("Man United mất Fernandes vì chấn thương", "Fernandes chấn thương.", [twin, other]).decision).toBe("new");
    expect(verdict("Man United mất Fernandes vì chấn thương", "Fernandes chấn thương.", [twin, known("Mason Fernandes chấn thương", "Man United.", "https://x/m")]).decision).toBe("duplicate");
  });
});

describe("meaningful follow-ups", () => {
  const original = known("Lille hạ Bayern 1-0 ở Champions League", "Lille thắng Bayern Munich ở Cup C1.", "https://tuoitre.vn/a");

  it("a changed score for the same fixture", () => {
    const result = verdict("Lille hạ Bayern 2-1 sau hiệp phụ", "Lille thắng Bayern ở Champions League.", [original]);
    expect(result.decision).toBe("follow_up");
    expect(codes(result)).toContain("score_changed");
  });

  it("a result after a preview, but a stale preview after a result is a duplicate", () => {
    const preview = known("Nhận định Lille vs Bayern", "Nhận định trước trận ở Champions League.", "https://x/p");
    expect(preview.identity.type).toBe("match_preview");
    const result = classifyEvent(original.identity, [preview]);
    expect(result.decision).toBe("follow_up");
    expect(codes(result)).toContain("event_type_changed");
    expect(classifyEvent(preview.identity, [original])).toMatchObject({ decision: "duplicate", reasons: expect.arrayContaining([{ code: "stale_preview_after_result" }]) });
  });

  it("rumor → official is a follow-up, official → rumor is a duplicate (English and Vietnamese)", () => {
    const rumor = known("Chelsea quan tâm Erling Haaland", "Tin đồn chuyển nhượng Erling Haaland.", "https://x/r");
    expect(verdict("Chelsea chính thức ký Erling Haaland", "Chuyển nhượng hoàn tất, Erling Haaland gia nhập Chelsea.", [rumor]).decision).toBe("follow_up");
    const official = known("Chelsea chính thức ký Erling Haaland", "Chuyển nhượng hoàn tất.", "https://x/o");
    expect(verdict("Chelsea có thể ký Erling Haaland", "Tin đồn chuyển nhượng Erling Haaland.", [official]).decision).toBe("duplicate");
    const en = known("Chelsea eyeing Erling Haaland transfer", "Reportedly interested in Erling Haaland.", "https://bbc.com/r");
    expect(verdict("Chelsea confirm Erling Haaland signing", "Erling Haaland joins Chelsea. Official.", [en]).decision).toBe("follow_up");
  });

  it("different individuals never collapse solely due to club/date/type", () => {
    const a = known("Chelsea chính thức ký Erling Haaland", "Erling Haaland gia nhập Chelsea.", "https://x/a");
    expect(verdict("Chelsea chính thức ký Kylian Mbappe", "Kylian Mbappe gia nhập Chelsea.", [a]).decision).toBe("new");
  });
});

describe("event payload", () => {
  it("carries decision, structured reasons, specificity and evidence of the matched event", () => {
    const old = known("Chelsea quan tâm Erling Haaland", "Tin đồn chuyển nhượng Erling Haaland.", "https://x/r");
    const next = buildEventIdentity(item("Chelsea chính thức ký Erling Haaland", "Chuyển nhượng hoàn tất, Erling Haaland gia nhập Chelsea."));
    const payload = buildEventPayload(next, classifyEvent(next, [old]));
    expect(payload).toMatchObject({
      decision: "follow_up", specific: true, eventKey: next.eventKey, clusterKey: next.clusterKey,
      matchedEventKey: old.identity.eventKey,
      reasons: expect.arrayContaining([{ code: "status_upgraded", detail: "rumor->official" }]),
      evidence: { matchedSourceUrl: "https://x/r", matchedTitle: "Chelsea quan tâm Erling Haaland", candidateStatus: "official", matchedStatus: "rumor", matchedOrigin: "stored" },
    });
    const fresh = buildEventPayload(next, classifyEvent(next, []));
    expect(fresh).toMatchObject({ decision: "new", reasons: [{ code: "no_matching_event" }] });
    expect(fresh).not.toHaveProperty("matchedEventKey");
    const vague = buildEventIdentity(item("Tin nóng bóng đá hôm nay", "Nhiều tin."));
    expect(buildEventPayload(vague, classifyEvent(vague, []))).toMatchObject({ specific: false });
  });
});
