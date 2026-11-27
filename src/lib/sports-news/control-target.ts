import "server-only";

import { z } from "zod";

const uuid = z.uuid();

export function sportsControlTarget(workspaceId: string) {
  const configuredWorkspace = uuid.safeParse(process.env.SPORTS_NEWS_WORKSPACE_ID);
  const project = uuid.safeParse(process.env.SPORTS_NEWS_PROJECT_ID);
  const destination = uuid.safeParse(process.env.SPORTS_NEWS_TELEGRAM_DESTINATION_ID);
  if (!configuredWorkspace.success || configuredWorkspace.data !== workspaceId ||
      !project.success || !destination.success) return null;
  return { workspaceId, projectId: project.data, destinationId: destination.data };
}
