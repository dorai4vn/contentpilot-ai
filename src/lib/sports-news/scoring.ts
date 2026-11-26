export type NewsAssessment = {
  playerPopularity: number;
  teamPopularity: number;
  competitionPopularity: number;
  eventImportance: number;
  reason: string;
};

export function calculateNewsScore(assessment: NewsAssessment, publishedAt: number, now: number): number {
  const ageHours = Math.max(0, now - publishedAt) / 3_600_000;
  const freshness = Math.max(0, 10 - ageHours / 4.8);
  // A major event can be relevant without a famous individual (e.g. a team final).
  const reach = Math.max(assessment.playerPopularity, assessment.teamPopularity, assessment.competitionPopularity);
  return Math.round((0.45 * reach + 0.40 * assessment.eventImportance + 0.15 * freshness) * 10) / 10;
}
