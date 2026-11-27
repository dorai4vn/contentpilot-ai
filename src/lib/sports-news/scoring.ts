export type NewsAssessment = {
  playerPopularity: number;
  teamPopularity: number;
  competitionPopularity: number;
  eventImportance: number;
  reason: string;
};

export type ScoringWeights = { reach: number; eventImportance: number; freshness: number };

export const SPORTS_SCORING_RUBRIC = {
  version: "sports-v1",
  weights: { reach: 0.45, eventImportance: 0.40, freshness: 0.15 },
  hoursPerFreshnessPoint: 4.8,
} as const;

export const SPORTS_NEWS_MAX_PER_RUN = 10;

export function scoreSportsNews(assessment: NewsAssessment, publishedAt: number, now: number,
  weights: ScoringWeights = SPORTS_SCORING_RUBRIC.weights) {
  const ageHours = Math.max(0, now - publishedAt) / 3_600_000;
  const freshness = Math.max(0, 10 - ageHours / SPORTS_SCORING_RUBRIC.hoursPerFreshnessPoint);
  const reach = Math.max(assessment.playerPopularity, assessment.teamPopularity, assessment.competitionPopularity);
  const score = Math.round((weights.reach * reach + weights.eventImportance * assessment.eventImportance
    + weights.freshness * freshness) * 10) / 10;
  return { score, reach, freshness: Math.round(freshness * 100) / 100 };
}

export function calculateNewsScore(assessment: NewsAssessment, publishedAt: number, now: number): number {
  return scoreSportsNews(assessment, publishedAt, now).score;
}

const footballPriorities = [
  /\b(ngoai hang anh|premier league|epl)\b/,
  /\b(cup c1|c1|champions league|ucl)\b/,
  /\b(fifa world cup|world cup|euro|copa america|nations league|asian cup|la liga|serie a|bundesliga|ligue 1|europa league)\b/,
  /\b(v league|bong da viet nam|(?:doi tuyen|u[0-9]{2}) viet nam|cup quoc gia viet nam|vff)\b/,
  /\b(bong da|cau thu|tien dao|thu mon|ban thang)\b/,
];

export function footballPriority(title: string, summary: string): number {
  const headline = normalize(title);
  const synopsis = normalize(summary);
  // Several other sports also call their competitions World Cup.
  if (/\b(billiards|bida|co thu|taekwondo|bong chuyen|bong ro|cau long|quan vot|futsal|dua xe)\b/.test(headline)) {
    return footballPriorities.length;
  }
  const headlineRank = footballPriorities.findIndex((pattern) => pattern.test(headline));
  if (headlineRank >= 0 && headlineRank < footballPriorities.length - 1) return headlineRank;
  const rank = footballPriorities.findIndex((pattern) => pattern.test(synopsis));
  return rank === -1 ? (headlineRank === -1 ? footballPriorities.length : headlineRank) : rank;
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, " ");
}

export function selectSportsNews<T extends { score: number; priority: number; item: { publishedAt: number } }>(
  entries: T[], threshold: number, fallbackMode: "highest" | "strict" = "highest",
) {
  const ranked = [...entries].sort((a, b) => b.score - a.score
    || a.priority - b.priority || b.item.publishedAt - a.item.publishedAt);
  const qualified = ranked.filter((entry) => entry.score >= threshold);
  return qualified.length
    ? { selected: qualified.slice(0, SPORTS_NEWS_MAX_PER_RUN), fallback: false }
    : fallbackMode === "highest"
      ? { selected: ranked.slice(0, 1), fallback: ranked.length > 0 }
      : { selected: [], fallback: false };
}
