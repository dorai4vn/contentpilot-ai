import { createHash } from "node:crypto";

import { dubaiDate } from "./publication-day";

/**
 * Deterministic semantic event identity (FN05). No LLM / network: the same article always yields the
 * same identity, so fixtures and regressions are reproducible. It complements (never replaces) the
 * URL and normalized-headline deduplication.
 */
export const EVENT_IDENTITY_VERSION = "event-v4";

export type EventType = "match_result" | "match_preview" | "transfer" | "injury" | "coach" | "discipline" | "other";
export type EventStatus = "rumor" | "reported" | "official";
/**
 * match: exactly two known teams (order-agnostic). person: a named individual plus the event type.
 * unresolved: the article is too sparse/ambiguous to name ONE event; it never suppresses or blocks anything
 * (fail open to normal scoring and manual review).
 */
export type SubjectKind = "match" | "person" | "unresolved";

export type EventIdentity = {
  version: typeof EVENT_IDENTITY_VERSION;
  subjectKind: SubjectKind;
  unresolvedReason: string | null;
  teams: string[];
  people: string[];
  /** teams + people, kept for display/evidence. */
  participants: string[];
  competition: string | null;
  type: EventType;
  status: EventStatus;
  scores: string[];
  /**
   * Material, verifiable facts found by fixed patterns (injury duration/diagnosis, transfer fee, contract length,
   * standings implication), e.g. "fee:50m". Part of eventKey: the same event with a NEW fact is a different key.
   */
  facts: string[];
  /** Calendar date (Asia/Dubai, same calendar as the publication-day rules). */
  date: string;
  eventKey: string;
  clusterKey: string;
  /**
   * clusterKey computed for date-1, date and date+1 (this event's own clusterKey included). The same-subject rule
   * accepts reports up to one calendar day apart, so the database recheck matches any of these keys: TS and DB
   * apply the same date semantics even when two runs race. Order: previous day, same day, next day.
   */
  clusterWindow: string[];
};

export type KnownEvent = {
  identity: EventIdentity;
  sourceUrl: string;
  title?: string;
  /** "stored" = stamped by the database; "derived" = rebuilt from title/body of an older row (no DB event key). */
  origin?: "stored" | "derived";
};

export type EventReason = { code: string; detail?: string };
export type EventDecision =
  | { decision: "new"; reasons: EventReason[] }
  | { decision: "duplicate" | "follow_up"; reasons: EventReason[]; matched: KnownEvent };

export function foldText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

// Only aliases that cannot be confused with ordinary words ("real", "mu", "inter", "viettel", "aff" are NOT
// aliases on their own). Anything not listed is simply unknown, which fails open.
const TEAMS: Record<string, string[]> = {
  "man-united": ["man united", "manchester united", "man utd", "manchester utd"],
  "man-city": ["man city", "manchester city"],
  liverpool: ["liverpool"],
  arsenal: ["arsenal"],
  chelsea: ["chelsea"],
  tottenham: ["tottenham", "spurs"],
  newcastle: ["newcastle"],
  "real-madrid": ["real madrid"],
  barcelona: ["barcelona", "barca"],
  "atletico-madrid": ["atletico madrid"],
  bayern: ["bayern munich", "bayern munchen", "bayern"],
  dortmund: ["dortmund", "borussia dortmund"],
  psg: ["psg", "paris saint germain", "paris saint-germain"],
  lille: ["lille"],
  juventus: ["juventus"],
  "ac-milan": ["ac milan"],
  "inter-milan": ["inter milan"],
  napoli: ["napoli"],
  "u23-viet-nam": ["u23 viet nam"],
  "hanoi-fc": ["ha noi fc", "cau lac bo ha noi"],
  "cong-an-ha-noi": ["cong an ha noi", "cahn"],
  "the-cong-viettel": ["the cong viettel"],
  "viet-nam": ["doi tuyen viet nam", "tuyen viet nam"],
  thailand: ["doi tuyen thai lan", "tuyen thai lan", "thailand national"],
  indonesia: ["doi tuyen indonesia", "tuyen indonesia"],
  malaysia: ["doi tuyen malaysia", "tuyen malaysia"],
};

// Bare country names are a team only when the headline is clearly about a match (score, "vs", result verbs).
const NATIONAL_TEAMS: Record<string, string[]> = {
  "viet-nam": ["viet nam"],
  thailand: ["thai lan", "thailand"],
  indonesia: ["indonesia"],
  malaysia: ["malaysia"],
};

const COMPETITIONS: Record<string, string[]> = {
  "premier-league": ["ngoai hang anh", "premier league", "epl"],
  "champions-league": ["champions league", "cup c1", "ucl"],
  "europa-league": ["europa league", "cup c2"],
  "la-liga": ["la liga"],
  "serie-a": ["serie a"],
  bundesliga: ["bundesliga"],
  "ligue-1": ["ligue 1"],
  "world-cup": ["world cup", "vong loai world cup"],
  "v-league": ["v league", "v-league"],
  "asian-cup": ["asian cup"],
  "aff-cup": ["aff cup"],
  "sea-games": ["sea games"],
};

const NON_PERSON_PHRASES = [
  "tay ban nha", "ha lan", "bo dao nha", "han quoc", "nhat ban", "trung quoc", "saudi arabia", "chau au", "chau a",
  "dong nam a", "viet nam", "thai lan", "my", "uc", "phap", "duc", "anh", "y", "brazil", "argentina", "indonesia", "malaysia",
  "premier league", "champions league", "europa league", "la liga", "serie a", "ligue 1", "world cup", "v league",
];

const NAME_STOPWORDS = new Set([
  "hlv", "tin", "chinh", "thuc", "bong", "da", "doi", "tuyen", "cau", "thu", "tran", "vong", "cup", "giai", "the",
  "nhan", "dinh", "viet", "nam", "sau", "truoc", "ban", "thang", "cap", "nhat", "man", "real", "sao", "sieu", "tan",
  "hau", "ve", "tien", "chan", "thuong", "hom", "nay", "khi", "vi", "voi", "cho", "cua", "trong", "mot", "nhung", "cac",
  "ngoi", "chu", "nha", "khach", "ket", "qua", "lich", "thi", "dau", "top", "mua", "ong", "ba", "bo", "tai", "tu", "den",
  "ra", "vao", "vang", "mat", "tru", "cot", "quan", "chien", "binh", "so", "hang", "nhi", "dong", "tin", "don", "nong",
  "chot", "bom", "tan", "cuu", "cong", "dan", "huan", "luyen", "vien", "chu", "tich", "bao", "chi", "ngay", "gio",
  "update", "breaking", "official", "exclusive", "report", "reports", "the", "and", "how", "why", "what", "after",
  "before", "new", "latest", "live", "manager", "coach", "star", "striker", "boss", "club", "premier", "league",
]);

type Alias = { id: string; phrase: string; words: number };

function aliasList(table: Record<string, string[]>): Alias[] {
  return Object.entries(table).flatMap(([id, phrases]) => phrases.map((phrase) => ({ id, phrase, words: phrase.split(" ").length })))
    .sort((a, b) => b.phrase.length - a.phrase.length);
}
const TEAM_ALIASES = aliasList(TEAMS);
const NATIONAL_ALIASES = aliasList(NATIONAL_TEAMS);
const COMPETITION_ALIASES = aliasList(COMPETITIONS);

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phraseRe = (phrase: string) => new RegExp(`(?<![a-z0-9])${escapeRe(phrase)}(?![a-z0-9])`, "g");

/** Longest alias first; a matched phrase is blanked so "u23 viet nam" never also yields "viet nam". */
function matchAliases(folded: string, aliases: Alias[]): { ids: string[]; rest: string } {
  const ids: string[] = [];
  let rest = folded;
  for (const alias of aliases) {
    const re = phraseRe(alias.phrase);
    if (re.test(rest)) {
      if (!ids.includes(alias.id)) ids.push(alias.id);
      rest = rest.replace(phraseRe(alias.phrase), " ");
    }
  }
  return { ids, rest };
}

function foldToken(token: string): string {
  return foldText(token).replace(/[^a-z0-9]+/g, "");
}

/**
 * Capitalised word runs of the HEADLINE that are not teams, competitions, countries or common sentence
 * starters. Multi-word names are accepted; a single word is accepted only when it is not the very first word of
 * the headline (sentence case would capitalise any word there) or when the summary also capitalises it.
 */
function extractPeople(title: string, summary: string): string[] {
  const names: string[] = [];
  const covered = new Set<string>([...TEAM_ALIASES, ...NATIONAL_ALIASES, ...COMPETITION_ALIASES].map((a) => a.phrase));
  const phrases = [...covered, ...NON_PERSON_PHRASES].sort((a, b) => b.length - a.length).map((p) => p.split(" "));
  for (const run of title.matchAll(/\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*)*/gu)) {
    const originals = run[0].split(/\s+/);
    const tokens = originals.map(foldToken);
    const blocked = tokens.map(() => false);
    for (const phrase of phrases) {
      for (let i = 0; i + phrase.length <= tokens.length; i++) {
        if (phrase.every((word, k) => tokens[i + k] === foldToken(word))) for (let k = 0; k < phrase.length; k++) blocked[i + k] = true;
      }
    }
    let group: number[] = [];
    const flush = () => {
      if (!group.length) return;
      const words = group.map((i) => tokens[i]);
      const startsTitle = run.index === 0 && group[0] === 0;
      const accepted = words.length >= 2
        ? words.every((w) => w.length >= 2)
        : words[0].length >= 3 && (!startsTitle || new RegExp(`(?<![\\p{L}])${escapeRe(originals[group[0]].replace(/[^\p{L}'’.-]/gu, ""))}(?![\\p{L}])`, "u").test(summary));
      if (accepted) names.push(words.join("-"));
      group = [];
    };
    tokens.forEach((token, i) => {
      if (blocked[i] || !token || NAME_STOPWORDS.has(token) || /^\d/.test(token)) flush();
      else group.push(i);
    });
    flush();
  }
  return [...new Set(names)];
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

export type Category = "transfer" | "injury" | "coach" | "discipline" | "match";

// `thang`/`hoa` collide with "tháng" (month) / "hoa" (flower) once diacritics are folded, so those two are
// tested on the original lower-cased text.
function categories(text: string, hasScore: boolean): { found: Category[]; preview: boolean } {
  const folded = foldText(text);
  const lower = text.normalize("NFC").toLowerCase();
  const found: Category[] = [];
  if (/\b(chuyen nhuong|gia nhap|ky hop dong|hop dong moi|chieu mo|ban dut|muon cau thu|ra mat|dam phan|hoi mua|transfers?|signs?|signed|signing|joins?|loan deal|agree[sd]? (?:a )?deal|here we go)\b/.test(folded)) found.push("transfer");
  if (/\b(chan thuong|dut day chang|phau thuat|lo tran|injur\w*|ruled out|sidelined|hamstring|acl)\b/.test(folded)) found.push("injury");
  if (/\b(sa thai|bo nhiem|tan hlv|huan luyen vien moi|tu chuc|dan dat|sacked|appointed|new manager|resigns?)\b/.test(folded)) found.push("coach");
  if (/\b(the do|treo gio|an phat|cam thi dau|the vang|red card|suspended|banned|fined)\b/.test(folded)) found.push("discipline");
  const resultWords = /\b(danh bai|ha guc|ha bep|chien thang|guc nga|that bai|thua|ket qua|vo dich|chung ket|beats?|defeats?|defeated|wins?|won|loses?|lost|draws?|drew|thrash\w*)\b/.test(folded)
    || /(?<![\p{L}])(thắng|hòa)(?![\p{L}])/u.test(lower);
  const preview = /\b(nhan dinh|du doan|truoc gio|truoc tran|doi hinh du kien|lich thi dau|soi keo|preview|prediction|predicted|team news|line-?ups?|vs|v)\b/.test(folded);
  if (hasScore || resultWords || preview) found.push("match");
  return { found, preview };
}

function eventStatus(folded: string): EventStatus {
  if (/\b(chinh thuc|xac nhan|official|here we go|da hoan tat|hoan tat|confirm(?:s|ed)?|announce[sd]?)\b/.test(folded)) return "official";
  if (/\b(tin don|co the|dang nham|du kien|can nhac|quan tam|nham toi|tiep can|dam phan|hoi mua|rumou?rs?|linked|eyeing|reportedly|interested|could)\b/.test(folded)) return "rumor";
  return "reported";
}

const MONTHS_UNIT: Record<string, string> = { tuan: "w", week: "w", weeks: "w", thang: "m", month: "m", months: "m", ngay: "d", day: "d", days: "d" };

/**
 * Deterministic material facts of a report. Only explicit, pattern-matched facts count (no inference, no AI):
 * wording changes never create a fact, a new number/diagnosis/implication does.
 */
export function extractFacts(title: string, summary: string, category: Category): string[] {
  const text = `${title}. ${summary}`;
  const lower = text.normalize("NFC").toLowerCase();
  const folded = foldText(text);
  const facts = new Set<string>();
  const num = (value: string) => String(Number(value.replace(",", ".")));
  if (category === "injury") {
    // "tháng" is tested on the diacritic-preserving text: folded it equals "thắng" (win).
    for (const m of lower.matchAll(/(?<![\p{L}\d])(\d{1,2})\s*(tuần|tháng|ngày|weeks?|months?|days?)(?![\p{L}])/gu)) {
      const unit = MONTHS_UNIT[foldText(m[2])];
      if (unit) facts.add(`duration:${num(m[1])}${unit}`);
    }
    if (/\b(het mua|season-ending|rest of the season|out for the season)\b/.test(folded)) facts.add("duration:season");
    for (const [re, name] of [[/\b(dut day chang|acl|cruciate)\b/, "acl"], [/\b(phau thuat|surgery|operation)\b/, "surgery"],
      [/\b(gay xuong|fracture|broken)\b/, "fracture"], [/\b(hamstring|co dui sau)\b/, "hamstring"]] as const) {
      if (re.test(folded)) facts.add(`diagnosis:${name}`);
    }
  }
  if (category === "transfer") {
    const amounts: [RegExp, number, number][] = [
      [/(?:€|£|\$)\s*(\d+(?:[.,]\d+)?)\s*(m\b|million|trieu|ty)?/g, 1, 2],
      [/(\d+(?:[.,]\d+)?)\s*(m\b|million|trieu|ty)\s*(?:euro|eur|usd|bang|pounds?|do la|dollars?)/g, 1, 2],
    ];
    for (const [re, a, u] of amounts) {
      for (const m of folded.matchAll(re)) {
        const unit = m[u];
        const value = Number(m[a].replace(",", "."));
        if (Number.isFinite(value) && value > 0) facts.add(`fee:${unit === "ty" ? value * 1000 : value}${unit ? "m" : ""}`);
      }
    }
  }
  if (category === "transfer" || category === "coach") {
    for (const m of folded.matchAll(/\b(?:den|until|through|to)\s+(?:het\s+)?(?:nam\s+|mua giai\s+)?(20\d\d)\b/g)) facts.add(`contract:${m[1]}`);
    for (const m of folded.matchAll(/(?:hop dong\s+(?:co thoi han\s+)?(\d{1,2})\s+nam|(\d{1,2})[- ]year (?:deal|contract))/g)) facts.add(`contract:${m[1] ?? m[2]}y`);
  }
  if (category === "match") {
    if (/\b(dau bang|ngoi dau|top of the (?:table|league)|go(?:es)? top|lead the table)\b/.test(folded)) facts.add("standing:top");
    if (/\b(xuong hang|relegat\w*)\b/.test(folded)) facts.add("standing:relegation");
    if (/\b(vao chung ket|vao vong|di tiep|qualif\w*|through to the (?:final|semi))\b/.test(folded)) facts.add("standing:qualified");
    if (/\b(vo dich|win the title|crowned champions)\b/.test(folded)) facts.add("standing:title");
  }
  return [...facts].sort();
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function buildEventIdentity(item: { title: string; summary: string; publishedAt: number; categories?: string }): EventIdentity {
  const title = item.title;
  const summary = item.summary ?? "";
  const titleFolded = foldText(title);
  const fullFolded = foldText(`${title}. ${summary}`);
  const date = dubaiDate(item.publishedAt);
  const competition = matchAliases(fullFolded, COMPETITION_ALIASES).ids[0] ?? null;

  const titleScores = scoresIn(titleFolded);
  const summaryScores = scoresIn(foldText(summary));
  const scores = titleScores.length ? titleScores : summaryScores.length === 1 ? summaryScores : [];

  let cats = categories(title, titleScores.length > 0);
  if (!cats.found.length) cats = categories(summary, false); // title carried no event verb: fall back to the body
  const unresolved = (reason: string, type: EventType = "other", teams: string[] = [], people: string[] = []): EventIdentity => {
    const key = hash([EVENT_IDENTITY_VERSION, "unresolved", titleFolded, date].join("|"));
    return {
      version: EVENT_IDENTITY_VERSION, subjectKind: "unresolved", unresolvedReason: reason, teams, people,
      participants: [...teams, ...people], competition, type, status: "reported", scores, facts: [], date, eventKey: key, clusterKey: key,
      clusterWindow: [key],
    };
  };
  if (cats.found.length === 0) return unresolved("no_event_type");
  if (cats.found.length > 1) return unresolved("mixed_event_types");

  const category = cats.found[0];
  const teamsInTitle = matchAliases(titleFolded, TEAM_ALIASES);
  if (category === "match") {
    const nationalInTitle = matchAliases(teamsInTitle.rest, NATIONAL_ALIASES).ids;
    const titleTeams = [...new Set([...teamsInTitle.ids, ...nationalInTitle])];
    let teams = titleTeams;
    if (titleTeams.length === 1) {
      const fromAll = matchAliases(fullFolded, TEAM_ALIASES);
      const all = [...new Set([...fromAll.ids, ...matchAliases(fromAll.rest, NATIONAL_ALIASES).ids])];
      if (all.length === 2 && all.includes(titleTeams[0])) teams = all;
    }
    if (teams.length < 2) return unresolved("fewer_than_two_teams", "other", teams);
    if (teams.length > 2) return unresolved("more_than_two_teams", "other", teams);
    const type: EventType = cats.preview && !titleScores.length ? "match_preview" : "match_result";
    const pair = [...teams].sort();
    // The competition is part of the key: the same two teams in two different known competitions are different
    // matches. An unknown competition hashes as "" (it is flagged for manual review by classifyEvent instead).
    const clusterAt = (d: string) => hash([EVENT_IDENTITY_VERSION, "match", type, pair.join(","), competition ?? "", d].join("|"));
    const clusterKey = clusterAt(date);
    const facts = extractFacts(title, summary, "match");
    const eventKey = hash([clusterKey, type === "match_result" ? scores.join(",") : "", facts.join(",")].join("|"));
    return {
      version: EVENT_IDENTITY_VERSION, subjectKind: "match", unresolvedReason: null, teams: pair, people: [],
      participants: pair, competition, type, status: "reported", scores: type === "match_result" ? scores : [], facts, date, eventKey, clusterKey,
      clusterWindow: [clusterAt(shiftDate(date, -1)), clusterKey, clusterAt(shiftDate(date, 1))],
    };
  }

  const type = category as EventType;
  const people = extractPeople(title, summary).sort();
  const teams = [...teamsInTitle.ids].sort();
  if (people.length === 0) return unresolved("no_named_person", type, teams);
  if (people.length > 2) return unresolved("too_many_people", type, teams, people);
  const status = eventStatus(titleFolded);
  const withTeams = type === "transfer" || type === "coach";
  const clusterAt = (d: string) => hash([EVENT_IDENTITY_VERSION, "person", type, people.join(","), withTeams ? teams.join(",") : "", d].join("|"));
  const clusterKey = clusterAt(date);
  const facts = extractFacts(title, summary, category);
  const eventKey = hash([clusterKey, status, facts.join(",")].join("|"));
  return {
    version: EVENT_IDENTITY_VERSION, subjectKind: "person", unresolvedReason: null, teams, people,
    participants: [...teams, ...people], competition, type, status, scores: [], facts, date, eventKey, clusterKey,
    clusterWindow: [clusterAt(shiftDate(date, -1)), clusterKey, clusterAt(shiftDate(date, 1))],
  };
}

const DAY = 24 * 60 * 60 * 1000;
const STATUS_RANK: Record<EventStatus, number> = { rumor: 0, reported: 1, official: 2 };

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Conservative alias handling: a single-word name ("Rashford") stands for a full name ("Marcus Rashford") only
 * when it is that name's LAST word, exactly one such full name exists, and both reports name the same club.
 */
function peopleMatch(a: EventIdentity, b: EventIdentity): { same: boolean; aliased: boolean } {
  if (sameSet(a.people, b.people)) return { same: true, aliased: false };
  if (!a.teams.some((t) => b.teams.includes(t))) return { same: false, aliased: false };
  const resolve = (mine: string[], other: string[]) => mine.map((name) => {
    if (name.includes("-")) return name;
    const full = other.filter((o) => o.includes("-") && o.split("-").at(-1) === name);
    return full.length === 1 ? full[0] : name;
  });
  const left = resolve(a.people, b.people);
  const right = resolve(b.people, a.people);
  return { same: sameSet(left, right) && left.some((n) => n.includes("-")), aliased: true };
}

/**
 * Whether two identities describe the same real-world subject (before follow-up analysis). Both must be
 * specific: unresolved identities never match anything.
 */
export function sameSubject(candidate: EventIdentity, known: EventIdentity): { same: boolean; reasons: EventReason[] } {
  const none = { same: false, reasons: [] as EventReason[] };
  if (candidate.subjectKind === "unresolved" || known.subjectKind !== candidate.subjectKind) return none;
  if (daysApart(candidate.date, known.date) > 1) return none;
  const dateReason = { code: "date_within_window", detail: `${known.date}~${candidate.date}` };
  if (candidate.subjectKind === "match") {
    if (!sameSet(candidate.teams, known.teams)) return none;
    // Same two teams in two different known competitions are different matches (e.g. league vs cup).
    // A known vs an unknown competition is NOT assumed to be the same match (classifyEvent flags it for review).
    if (candidate.competition !== known.competition) return none;
    return { same: true, reasons: [{ code: "same_team_pair", detail: candidate.teams.join(" vs ") }, dateReason] };
  }
  if (candidate.type !== known.type) return none; // a different kind of news about one player is a different event
  const people = peopleMatch(candidate, known);
  if (!people.same) return none;
  if ((candidate.type === "transfer" || candidate.type === "coach") && !sameSet(candidate.teams, known.teams)) return none;
  return {
    same: true,
    reasons: [{ code: people.aliased ? "same_person_alias" : "same_person", detail: candidate.people.join(",") }, { code: "same_event_type", detail: candidate.type }, dateReason],
  };
}

/** A surname-only alias is refused when another known player of that club has the same surname. */
function aliasIsAmbiguous(candidate: EventIdentity, matched: EventIdentity, known: readonly KnownEvent[]): boolean {
  const singles = candidate.people.filter((name) => !name.includes("-"));
  return singles.some((surname) => {
    const fullNames = new Set<string>();
    for (const entry of known) {
      const other = entry.identity;
      if (other.subjectKind !== "person" || other.type !== candidate.type || !other.teams.some((t) => candidate.teams.includes(t))) continue;
      for (const name of other.people) if (name.includes("-") && name.split("-").at(-1) === surname) fullNames.add(name);
    }
    return fullNames.size > 1 && matched.people.length > 0;
  });
}

/**
 * Compare a candidate with already-known (accepted/materialized) events. duplicate: same event, nothing new.
 * follow_up: same subject with material new information (preview → result, firmer status such as
 * rumor → official, or a changed score). new: unrelated, or the identity is not specific enough to judge.
 */
export function classifyEvent(candidate: EventIdentity, known: readonly KnownEvent[]): EventDecision {
  if (candidate.subjectKind === "unresolved") {
    return { decision: "new", reasons: [{ code: "identity_not_specific", detail: candidate.unresolvedReason ?? "unresolved" }] };
  }
  let best: EventDecision | null = null;
  for (const entry of known) {
    const old = entry.identity;
    if (old.version !== candidate.version || old.subjectKind === "unresolved") continue;
    const subject = sameSubject(candidate, old);
    if (!subject.same) continue;
    const reasons = [...subject.reasons];
    if (reasons.some((r) => r.code === "same_person_alias") && aliasIsAmbiguous(candidate, old, known)) continue;
    if (old.eventKey === candidate.eventKey) {
      return { decision: "duplicate", matched: entry, reasons: [{ code: "same_event_key" }, ...reasons] };
    }
    // Material facts (injury duration, fee, contract, standings...) the known report did not carry. A key with a
    // different value is a conflicting fact: still a follow-up, but flagged so it only goes to manual review.
    const added = candidate.facts.filter((fact) => !old.facts.includes(fact));
    const conflicting = added.filter((fact) => old.facts.some((o) => o.split(":")[0] === fact.split(":")[0]));
    const factReason = (): EventReason[] => added.length
      ? [{ code: conflicting.length ? "fact_changed" : "new_material_facts", detail: added.join(",") }] : [];
    if (candidate.subjectKind === "match") {
      if (old.type === "match_preview" && candidate.type === "match_result") {
        reasons.push({ code: "event_type_changed", detail: "match_preview->match_result" });
        best = { decision: "follow_up", matched: entry, reasons };
        continue;
      }
      if (old.type === "match_result" && candidate.type === "match_result" && candidate.scores.length && old.scores.length
        && candidate.scores.join(",") !== old.scores.join(",")) {
        reasons.push({ code: "score_changed", detail: `${old.scores.join(",")}->${candidate.scores.join(",")}` });
        best = { decision: "follow_up", matched: entry, reasons };
        continue;
      }
      if (added.length && candidate.type === old.type) {
        best = { decision: "follow_up", matched: entry, reasons: [...reasons, ...factReason()] };
        continue;
      }
      reasons.push({ code: old.type === candidate.type ? "same_match_report" : "stale_preview_after_result" });
      return { decision: "duplicate", matched: entry, reasons };
    }
    if (STATUS_RANK[candidate.status] > STATUS_RANK[old.status]) {
      reasons.push({ code: "status_upgraded", detail: `${old.status}->${candidate.status}` });
      best = { decision: "follow_up", matched: entry, reasons };
      continue;
    }
    if (added.length) {
      best = { decision: "follow_up", matched: entry, reasons: [...reasons, ...factReason()] };
      continue;
    }
    reasons.push({ code: "no_new_information", detail: `${old.status}->${candidate.status}` });
    return { decision: "duplicate", matched: entry, reasons };
  }
  if (best) return best;
  // Same two teams within the date window but the competition is known on only one side: not provably the same
  // match, so it is kept (no false-positive suppression) and routed to manual review only.
  if (candidate.subjectKind === "match") {
    const unverified = known.find((entry) => {
      const old = entry.identity;
      return old.version === candidate.version && old.subjectKind === "match" && old.type === candidate.type
        && sameSet(candidate.teams, old.teams) && daysApart(candidate.date, old.date) <= 1
        && (candidate.competition === null) !== (old.competition === null);
    });
    if (unverified) return { decision: "new", reasons: [{ code: "competition_unverified", detail: `${unverified.identity.competition ?? "none"}|${candidate.competition ?? "none"}` }] };
  }
  return { decision: "new", reasons: [{ code: "no_matching_event" }] };
}

const SUBJECT_KINDS = new Set(["match", "person", "unresolved"]);
const EVENT_TYPES = new Set(["match_result", "match_preview", "transfer", "injury", "coach", "discipline", "other"]);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];

/** Reads a stored identity back from sports_news_items.event_identity; anything malformed is ignored. */
export function parseStoredIdentity(value: unknown): EventIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const key = /^[0-9a-f]{64}$/;
  if (v.version !== EVENT_IDENTITY_VERSION || typeof v.eventKey !== "string" || !key.test(v.eventKey)
    || typeof v.clusterKey !== "string" || !key.test(v.clusterKey) || typeof v.date !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !Array.isArray(v.teams) || !Array.isArray(v.people) || !Array.isArray(v.scores)
    || typeof v.subjectKind !== "string" || !SUBJECT_KINDS.has(v.subjectKind)
    || typeof v.type !== "string" || !EVENT_TYPES.has(v.type)
    || (v.status !== "rumor" && v.status !== "reported" && v.status !== "official")) return null;
  const teams = strings(v.teams);
  const people = strings(v.people);
  return {
    version: EVENT_IDENTITY_VERSION,
    subjectKind: v.subjectKind as SubjectKind,
    unresolvedReason: typeof v.unresolvedReason === "string" ? v.unresolvedReason : null,
    teams, people, participants: [...teams, ...people],
    competition: typeof v.competition === "string" ? v.competition : null,
    type: v.type as EventType,
    status: v.status,
    scores: strings(v.scores),
    facts: strings(v.facts),
    date: v.date, eventKey: v.eventKey, clusterKey: v.clusterKey,
    clusterWindow: strings(v.clusterWindow).filter((k) => key.test(k)).length === 3 && strings(v.clusterWindow).includes(v.clusterKey)
      ? strings(v.clusterWindow) : [v.clusterKey],
  };
}

export type ManualReviewReason = "unresolved_identity" | "follow_up" | "reconsidered" | "uncertain_facts";

/**
 * Why a candidate may only go through manual review and never through the temporary auto-publish window, or null
 * for a regular eligible item. `reconsidered`: the event matches a post that was archived/rejected without ever
 * being sent. The database re-derives the same decision (record_sports_news_event_assessment).
 */
export function manualReviewReason(identity: EventIdentity, verdict: EventDecision, reconsidered = false): ManualReviewReason | null {
  if (identity.subjectKind === "unresolved") return "unresolved_identity";
  if (verdict.decision === "follow_up") return verdict.reasons.some((r) => r.code === "fact_changed") ? "uncertain_facts" : "follow_up";
  if (verdict.reasons.some((r) => r.code === "competition_unverified")) return "uncertain_facts";
  return reconsidered ? "reconsidered" : null;
}

/** The JSON payload stored by record_sports_news_event_* (decision, identity, structured reasons, evidence). */
export function buildEventPayload(identity: EventIdentity, verdict: EventDecision, manual: ManualReviewReason | null = null) {
  const matched = verdict.decision === "new" ? null : verdict.matched;
  return {
    decision: verdict.decision === "follow_up" ? "follow_up" : "new",
    /** Only a specific identity may be used by the database to suppress or block anything. */
    specific: identity.subjectKind !== "unresolved",
    ...(manual ? { manualReviewReason: manual } : {}),
    eventKey: identity.eventKey,
    clusterKey: identity.clusterKey,
    clusterWindow: identity.clusterWindow,
    identity,
    reasons: verdict.reasons,
    ...(matched ? {
      matchedEventKey: matched.identity.eventKey,
      evidence: {
        matchedSourceUrl: matched.sourceUrl,
        ...(matched.title ? { matchedTitle: matched.title.slice(0, 300) } : {}),
        matchedOrigin: matched.origin ?? "stored",
        matchedParticipants: matched.identity.participants,
        matchedType: matched.identity.type,
        matchedStatus: matched.identity.status,
        matchedScores: matched.identity.scores,
        matchedFacts: matched.identity.facts,
        matchedDate: matched.identity.date,
        candidateParticipants: identity.participants,
        candidateType: identity.type,
        candidateStatus: identity.status,
        candidateScores: identity.scores,
        candidateFacts: identity.facts,
        candidateDate: identity.date,
        competition: identity.competition,
      },
    } : {}),
  };
}
