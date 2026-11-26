import { z } from "zod";

const windowSchema = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  destinationId: z.uuid(),
});

export const AUTO_PUBLISH_MAX_WINDOW_MS = 8 * 60 * 60 * 1000;
export const AUTO_PUBLISH_MAX_POSTS = 40;
export const AUTO_PUBLISH_MAX_PER_RUN = 10;

/** Fail closed. This pure guard is not a substitute for database authorization. */
export function permitsTemporaryAutoPublish(
  raw: unknown,
  candidate: { workspaceId: string; projectId: string; destinationId: string; kind: string; source: string; createdAt: number; publishedAt: number; testMode: boolean },
  now: number,
): boolean {
  const result = windowSchema.safeParse(raw);
  if (!result.success || !Number.isFinite(now)) return false;
  const w = result.data;
  const start = Date.parse(w.startsAt);
  const end = Date.parse(w.endsAt);
  return end > start && end - start <= AUTO_PUBLISH_MAX_WINDOW_MS &&
    now >= start && now < end &&
    candidate.workspaceId === w.workspaceId &&
    candidate.projectId === w.projectId &&
    candidate.destinationId === w.destinationId &&
    candidate.kind === "telegram" && candidate.source === "rss" && !candidate.testMode &&
    Number.isFinite(candidate.createdAt) && candidate.createdAt >= start && candidate.createdAt <= now &&
    Number.isFinite(candidate.publishedAt) && candidate.publishedAt <= now;
}
