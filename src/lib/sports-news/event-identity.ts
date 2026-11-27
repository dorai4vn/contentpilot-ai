import { createHash } from "node:crypto";

import { dubaiDate } from "./publication-day";

/**
 * Deterministic semantic event identity (FN05). No LLM / network: the same article always yields the
 * same identity, so fixtures and regressions are reproducible. It complements (never replaces) the
 * URL and normalized-headline deduplication.
 */
export const EVENT_IDENTITY_VERSION = "event-v1";

export type EventType = "match_result" | "match_preview" | "transfer" | "injury" | "coach" | "discipline" | "other";
export type EventStatus = "rumor" | "reported" | "official";

export type EventIdentity = {
  version: typeof EVENT_IDENTITY_VERSION;
  participants: string[];
  competition: string | null;
  type: EventType;
  status: EventStatus;
  scores: string[];
  /** Calendar date (Asia/Dubai, same calendar as the publication-day rules). */
  date: string;
  eventKey: string;
  clusterKey: string;
};

export type KnownEvent = {
  identity: EventIdentity;
  sourceUrl: string;
  title?: string;
};

export type EventReason = { code: string; detail?: string };
export type EventDecision =
  | { decision: "new"; reasons: EventReason[] }
  | { decision: "duplicate" | "follow_up"; reasons: EventReason[]; matched: KnownEvent };

export function foldText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

const TEAMS: Record<string, string[]> = {
  "man-united": ["man united", "manchester united", "man utd", "mu"],
  "man-city": ["man city", "manchester city"],
  liverpool: ["liverpool"],
  arsenal: ["arsenal"],
  chelsea: ["chelsea"],
  tottenham: ["tottenham", "spurs"],
  newcastle: ["newcastle"],
  "real-madrid": ["real madrid", "real"],
  barcelona: ["barcelona", "barca"],
  "atletico-madrid": ["atletico madrid", "atletico"],
  bayern: ["bayern munich", "bayern munchen", "bayern"],
  dortmund: ["dortmund", "borussia dortmund"],
  psg: ["psg", "paris saint germain"],
  lille: ["lille"],
  juventus: ["juventus", "juve"],
  "ac-milan": ["ac milan"],
  inter: ["inter milan", "inter"],
  napoli: ["napoli"],
  "viet-nam": ["doi tuyen viet nam", "tuyen viet nam", "viet nam"],
  thailand: ["thai lan", "thailand"],
  indonesia: ["indonesia"],
  malaysia: ["malaysia"],
  "u23-viet-nam": ["u23 viet nam"],
  "hanoi-fc": ["ha noi fc", "cau lac bo ha noi"],
  "cong-an-ha-noi": ["cong an ha noi", "cahn"],
  "the-cong-viettel": ["the cong viettel", "viettel"],
};

const COMPETITIONS: Record<string, string[]> = {
  "premier-league": ["ngoai hang anh", "premier league", "epl"],
  "champions-league": ["champions league", "cup c1", "c1", "ucl"],
  "europa-league": ["europa league", "cup c2"],
  "la-liga": ["la liga"],
  "serie-a": ["serie a"],
  bundesliga: ["bundesliga"],
  "ligue-1": ["ligue 1"],
  "world-cup": ["world cup", "vong loai world cup"],
  "v-league": ["v league", "v-league"],
  "asian-cup": ["asian cup"],
  "aff-cup": ["aff cup", "aff"],
  "sea-games": ["sea games"],
};

function containsPhrase(folded: string, phrase: string): boolean {
  return new RegExp(`(?<![a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(folded);
}

function matchAliases(folded: string, table: Record<string, string[]>): string[] {
  const found: string[] = [];
  for (const [id, aliases] of Object.entries(table)) {
    // Longest alias first inside one entry is irrelevant; any alias hit counts once per entry.
    if (aliases.some((alias) => containsPhrase(folded, alias))) found.push(id);
  }
  return found;
}

// Capitalised word runs ("Erling Haaland", "Mbappe") are treated as person/club names. Names that are
// the first word of a sentence are ambiguous in Vietnamese headlines, so common starters are ignored.
const NAME_STOPWORDS = new Set([
  "hlv", "tin", "chinh", "thuc", "bong", "da", "doi", "tuyen", "cau", "thu", "tran", "vong", "cup", "giai", "the",
  "nhan", "dinh", "viet", "nam", "sau", "truoc", "ban", "thang", "cap", "nhat", "man", "real",
]);

function extractNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+)*/gu)) {
    const folded = foldText(match[0]).replace(/[^a-z0-9 ]+/g, "").trim();
    if (folded.length < 3 || NAME_STOPWORDS.has(folded)) continue;
    // A name already explained by a dictionary alias is not repeated.
    if (matchAliases(folded, TEAMS).length || matchAliases(folded, COMPETITIONS).length) continue;
    names.add(folded.replace(/\s+/g, "-"));
  }
  return [...names];
}

function scoresIn(folded: string): string[] {
  const scores = new Set<string>();
  for (const match of folded.matchAll(/(?<![0-9:])(\d{1,2})\s*[-:]\s*(\d{1,2})(?![0-9:])/g)) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    if (a > 15 || b > 15) continue; // a time like 20-30 or a date fragment, not a football score
    scores.add(`${Math.min(a, b)}-${Math.max(a, b)}`); // orientation-agnostic: 1-0 and 0-1 are the same result
  }
  return [...scores].sort();
}

function eventType(folded: string, scores: string[]): EventType {
  if (/\b(chuyen nhuong|gia nhap|ky hop dong|hop dong moi|chieu mo|ban dut|muon cau thu|ra mat|transfer|signs?)\b/.test(folded)) return "transfer";
  if (/\b(chan thuong|vang mat|dut day chang|phau thuat|injur\w*)\b/.test(folded)) return "injury";
  if (/\b(sa thai|bo nhiem|tan hlv|huan luyen vien moi|tu chuc|dan dat)\b/.test(folded)) return "coach";
  if (/\b(the do|treo gio|an phat|cam thi dau|the vang)\b/.test(folded)) return "discipline";
  if (scores.length || /\b(danh bai|ha guc|ha bep|chien thang|guc nga|that bai|thang|thua|hoa|ket qua|vo dich|chung ket)\b/.test(folded)) return "match_result";
  if (/\b(nhan dinh|du doan|truoc gio|truoc tran|doi hinh du kien|lich thi dau|soi keo)\b/.test(folded)) return "match_preview";
  return "other";
}

function eventStatus(folded: string): EventStatus {
  if (/\b(chinh thuc|xac nhan|official|here we go|da hoan tat|hoan tat)\b/.test(folded)) return "official";
  if (/\b(tin don|co the|dang nham|du kien|can nhac|quan tam|nham toi|tiep can|dam phan)\b/.test(folded)) return "rumor";
  return "reported";
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function buildEventIdentity(item: { title: string; summary: string; publishedAt: number; categories?: string }): EventIdentity {
  const text = `${item.title}. ${item.summary}`;
  const folded = foldText(text);
  const titleFolded = foldText(item.title);
  const scores = scoresIn(titleFolded).length ? scoresIn(titleFolded) : scoresIn(folded);
  const teams = matchAliases(folded, TEAMS);
  const competitions = matchAliases(folded, COMPETITIONS);
  const participants = [...new Set([...teams, ...extractNames(item.title)])].sort().slice(0, 8);
  const type = eventType(titleFolded + " " + folded, scores);
  const status = eventStatus(titleFolded);
  const competition = competitions[0] ?? null;
  const date = dubaiDate(item.publishedAt);
  const scoreKey = type === "match_result" ? scores.join(",") : "";
  const clusterKey = hash([EVENT_IDENTITY_VERSION, type, competition ?? "", participants.join(","), date].join("|"));
  const eventKey = hash([clusterKey, status, scoreKey].join("|"));
  return { version: EVENT_IDENTITY_VERSION, participants, competition, type, status, scores, date, eventKey, clusterKey };
}

const DAY = 24 * 60 * 60 * 1000;
const STATUS_RANK: Record<EventStatus, number> = { rumor: 0, reported: 1, official: 2 };

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;
}

function sharedParticipants(a: EventIdentity, b: EventIdentity): string[] {
  const other = new Set(b.participants);
  return a.participants.filter((p) => other.has(p));
}

/** Whether two identities describe the same real-world subject (before follow-up analysis). */
export function sameSubject(candidate: EventIdentity, known: EventIdentity): { same: boolean; reasons: EventReason[] } {
  const shared = sharedParticipants(candidate, known);
  const smaller = Math.min(candidate.participants.length, known.participants.length);
  const enough = shared.length >= 2 || (shared.length === 1 && smaller === 1);
  if (!enough) return { same: false, reasons: [] };
  if (candidate.competition && known.competition && candidate.competition !== known.competition) {
    return { same: false, reasons: [] };
  }
  if (daysApart(candidate.date, known.date) > 1) return { same: false, reasons: [] };
  const reasons: EventReason[] = [
    { code: "participants_overlap", detail: shared.join(",") },
    { code: "date_within_window", detail: `${known.date}~${candidate.date}` },
  ];
  if (candidate.competition && candidate.competition === known.competition) {
    reasons.push({ code: "same_competition", detail: candidate.competition });
  }
  return { same: true, reasons };
}

/**
 * Compare a candidate with already-known events. duplicate: same event, nothing new. follow_up: same
 * subject but a different event type, a more certain status (rumor → official) or a changed score, so it
 * is meaningful new information. new: unrelated.
 */
export function classifyEvent(candidate: EventIdentity, known: readonly KnownEvent[]): EventDecision {
  let best: EventDecision | null = null;
  for (const entry of known) {
    if (entry.identity.version !== candidate.version) continue;
    if (entry.identity.eventKey === candidate.eventKey) {
      return { decision: "duplicate", matched: entry, reasons: [{ code: "same_event_key" }] };
    }
    const subject = sameSubject(candidate, entry.identity);
    if (!subject.same) continue;
    const old = entry.identity;
    const reasons = [...subject.reasons];
    if (old.type !== candidate.type) {
      reasons.push({ code: "event_type_changed", detail: `${old.type}->${candidate.type}` });
      best = { decision: "follow_up", matched: entry, reasons };
    } else if (STATUS_RANK[candidate.status] > STATUS_RANK[old.status]) {
      reasons.push({ code: "status_upgraded", detail: `${old.status}->${candidate.status}` });
      best = { decision: "follow_up", matched: entry, reasons };
    } else if (candidate.type === "match_result" && candidate.scores.length && old.scores.length
      && candidate.scores.join(",") !== old.scores.join(",")) {
      reasons.push({ code: "score_changed", detail: `${old.scores.join(",")}->${candidate.scores.join(",")}` });
      best = { decision: "follow_up", matched: entry, reasons };
    } else {
      // Same subject, same kind of news, nothing more certain: a rewrite from another source.
      reasons.push({ code: "same_event_type", detail: old.type });
      return { decision: "duplicate", matched: entry, reasons };
    }
  }
  return best ?? { decision: "new", reasons: [{ code: "no_matching_event" }] };
}

/** Reads a stored identity back from sports_news_items.event_identity; anything malformed is ignored. */
export function parseStoredIdentity(value: unknown): EventIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const key = /^[0-9a-f]{64}$/;
  if (v.version !== EVENT_IDENTITY_VERSION || typeof v.eventKey !== "string" || !key.test(v.eventKey)
    || typeof v.clusterKey !== "string" || !key.test(v.clusterKey) || typeof v.date !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !Array.isArray(v.participants) || !Array.isArray(v.scores)
    || typeof v.type !== "string" || typeof v.status !== "string") return null;
  return {
    version: EVENT_IDENTITY_VERSION,
    participants: v.participants.filter((p): p is string => typeof p === "string"),
    competition: typeof v.competition === "string" ? v.competition : null,
    type: v.type as EventType,
    status: v.status as EventStatus,
    scores: v.scores.filter((s): s is string => typeof s === "string"),
    date: v.date, eventKey: v.eventKey, clusterKey: v.clusterKey,
  };
}

/** The JSON payload stored by record_sports_news_event_* (decision, identity, structured reasons, evidence). */
export function buildEventPayload(identity: EventIdentity, verdict: EventDecision) {
  const matched = verdict.decision === "new" ? null : verdict.matched;
  return {
    decision: verdict.decision === "follow_up" ? "follow_up" : "new",
    eventKey: identity.eventKey,
    clusterKey: identity.clusterKey,
    identity,
    reasons: verdict.reasons,
    ...(matched ? {
      matchedEventKey: matched.identity.eventKey,
      evidence: {
        matchedSourceUrl: matched.sourceUrl,
        matchedParticipants: matched.identity.participants,
        matchedType: matched.identity.type,
        matchedStatus: matched.identity.status,
        matchedDate: matched.identity.date,
        candidateParticipants: identity.participants,
        candidateType: identity.type,
        candidateStatus: identity.status,
        candidateDate: identity.date,
        competition: identity.competition,
      },
    } : {}),
  };
}
