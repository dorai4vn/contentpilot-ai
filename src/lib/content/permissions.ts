import type { WorkspaceRole } from "@/types/database";

/**
 * What the UI offers to a role. Mirrors the RLS policies of the M2 migration;
 * it only hides controls — the database enforces every rule independently.
 */
export function contentPermissions(role: WorkspaceRole) {
  const manager = role === "owner" || role === "admin";
  return {
    /** Create, rename, archive and restore projects. */
    manageProjects: manager,
    /** Create, edit, change status, archive and restore posts (any member). */
    editPosts: true,
  };
}

export type ContentPermissions = ReturnType<typeof contentPermissions>;
