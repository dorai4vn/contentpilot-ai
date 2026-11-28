/**
 * FN11-A3b typed entity / alias matching for image provenance. Pure, no I/O.
 * Article provenance is NOT unconditional proof: a hint (alt/caption/filename) that names a known club different from
 * the clubs in the title, or a different age group, rejects the candidate even when the image came from the article.
 */

const norm = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");

/** canonical club -> aliases (normalised, whole-word / phrase). Extend freely; unknown clubs only get token matching. */
export const TEAM_ALIASES: Record<string, string[]> = {
  arsenal: ["arsenal", "phao thu", "gunners"],
  "man city": ["man city", "manchester city", "man xanh", "mancity"],
  "man united": ["man united", "manchester united", "man utd", "quy do"],
  chelsea: ["chelsea"],
  liverpool: ["liverpool"],
  tottenham: ["tottenham", "spurs", "tottenham hotspur"],
  brighton: ["brighton"],
  "nottingham forest": ["nottingham forest", "nottingham"],
  newcastle: ["newcastle"],
  "aston villa": ["aston villa"],
  "west ham": ["west ham"],
  everton: ["everton"],
  "real madrid": ["real madrid"],
  barcelona: ["barcelona", "barca"],
  "atletico madrid": ["atletico madrid", "atletico"],
  juventus: ["juventus", "juve"],
  milan: ["ac milan", "milan"],
  inter: ["inter milan", "inter"],
  napoli: ["napoli"],
  bayern: ["bayern munich", "bayern"],
  dortmund: ["dortmund", "borussia dortmund"],
  psg: ["psg", "paris saint germain"],
  "columbus crew": ["columbus crew", "columbus"],
  japan: ["japan", "nhat ban"],
  honduras: ["honduras"],
  vietnam: ["vietnam", "viet nam"],
  thailand: ["thailand", "thai lan"],
  brazil: ["brazil"],
  argentina: ["argentina"],
  france: ["france"],
  england: ["england"],
  germany: ["germany"],
  spain: ["spain", "tay ban nha"],
};

export const COMPETITION_ALIASES: Record<string, string[]> = {
  "premier league": ["premier league", "ngoai hang anh"],
  "champions league": ["champions league", "cup c1"],
  "europa league": ["europa league", "cup c2"],
  "la liga": ["la liga"],
  "serie a": ["serie a"],
  bundesliga: ["bundesliga"],
  "ligue 1": ["ligue 1"],
  "world cup": ["world cup"],
  "v league": ["v league", "v-league"],
};

export type Topic = "match" | "portrait" | "press_conference" | "transfer" | "injury";

function present(text: string, phrase: string) {
  return new RegExp(`(?:^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(text);
}

function find(text: string, table: Record<string, string[]>): Set<string> {
  const n = ` ${norm(text)} `;
  const out = new Set<string>();
  for (const [canonical, aliases] of Object.entries(table)) if (aliases.some((alias) => present(n, alias))) out.add(canonical);
  return out;
}

export const teamsIn = (text: string) => find(text, TEAM_ALIASES);
export const competitionsIn = (text: string) => find(text, COMPETITION_ALIASES);

export function topicOf(title: string): Topic {
  const n = norm(title);
  if (/(chan thuong|chấn thương|injur|nghi dai han|phau thuat|dut day chang)/.test(n)) return "injury";
  if (/(hop bao|press conference|phat bieu|cho biet sau tran)/.test(n)) return "press_conference";
  if (/(chuyen nhuong|transfer|gia nhap|ky hop dong|here we go|hop dong|roi |tai hop)/.test(n)) return "transfer";
  if (/(\bvs\b|\bv\b|thang|thua|hoa|tran |ket qua|bang dong|ghi ban|dau voi|ty so|\d+\s*-\s*\d+)/.test(n)) return "match";
  return "portrait";
}

/** Capitalised multi-word names from the ORIGINAL title (typed as person/other when not a known club/competition). */
export function personLikeNames(title: string): string[] {
  const known = new Set([...teamsIn(title), ...competitionsIn(title)]);
  const matches = title.match(/\p{Lu}[\p{Ll}'’-]{2,}(?:\s+\p{Lu}[\p{Ll}'’-]{2,})+/gu) ?? [];
  return matches.filter((name) => ![...known].some((k) => norm(name).includes(k))).map(norm);
}

export type EntityVerdict = "match" | "conflict" | "none";

/**
 * Compares title entities with candidate hint entities.
 *  - conflict: hint names a known club that is not in the title (wrong team), or the title has clubs and the hint
 *    names only OTHER clubs.
 *  - match: >=1 shared typed team/competition, or a shared multi-word person name (full name / two tokens), or >=2
 *    distinct shared tokens of length>=4. A single shared generic token is NOT enough (ambiguous).
 *  - none: nothing to decide.
 */
export function compareEntities(title: string, hint: string): EntityVerdict {
  const titleTeams = teamsIn(title);
  const hintTeams = teamsIn(hint);
  const extra = [...hintTeams].filter((team) => !titleTeams.has(team));
  if (hintTeams.size > 0 && titleTeams.size > 0) {
    if (extra.length > 0 && ![...hintTeams].some((team) => titleTeams.has(team))) return "conflict";
    if (extra.length > 0) return "conflict"; // hint adds a team that is not part of the story (e.g. title Arsenal-City, hint Chelsea)
  }
  if ([...hintTeams].some((team) => titleTeams.has(team))) return "match";
  const hintNorm = norm(hint);
  for (const name of personLikeNames(title)) if (name.split(/\s+/).every((part) => hintNorm.includes(part))) return "match";
  const shared = new Set<string>();
  const titleTokens = norm(title).match(/[a-z0-9]{4,}/g) ?? [];
  const hintTokens = new Set(hintNorm.match(/[a-z0-9]{4,}/g) ?? []);
  const generic = new Set(["football", "soccer", "match", "stadium", "player", "players", "team", "league", "cup", "photo", "image", "jpeg", "jpg", "webp", "png", "tran", "doi", "cua", "bong"]);
  for (const token of titleTokens) if (hintTokens.has(token) && !generic.has(token) && !/^\d+$/.test(token)) shared.add(token);
  if (shared.size >= 2) return "match";
  return "none";
}
