import "server-only";

import { notFound } from "next/navigation";
import { cache } from "react";

import { requireUser } from "@/lib/auth/dal";
import { contentPermissions } from "@/lib/content/permissions";
import { uuidSchema } from "@/lib/validation/content";
import { getMyWorkspace } from "@/lib/workspaces/queries";

/** Validates a route id; malformed ids are a 404, never a database query. */
export function routeId(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) notFound();
  return parsed.data;
}

/**
 * Signed-in user + workspace + role for a content page. Not a member (or no such
 * workspace) -> 404, so the page does not reveal whether the workspace exists.
 * Memoised per request (layout and page both call it).
 */
export const loadWorkspace = cache(async (workspaceIdParam: string, nextPath: string) => {
  const user = await requireUser(nextPath);
  const workspaceId = routeId(workspaceIdParam);
  const workspace = await getMyWorkspace(user, workspaceId);
  if (!workspace) notFound();
  return { user, workspace, permissions: contentPermissions(workspace.role) };
});
