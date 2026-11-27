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
    /** Rename the workspace (owners/admins, mirrors the workspaces UPDATE policy). */
    manageWorkspace: manager,
    /** Create, edit, change status, archive and restore posts (any member). */
    editPosts: true,
  };
}

export type ContentPermissions = ReturnType<typeof contentPermissions>;

/**
 * Publish approval (M4). Mirrors the database: any member may ask for a post to
 * be published; only owners/admins approve or reject. The requester or an
 * owner/admin may cancel. UI hints only — the RPCs enforce every rule.
 */
export function publishPermissions(role: WorkspaceRole) {
  const manager = role === "owner" || role === "admin";
  return { requestPublish: true, decidePublish: manager, cancelAnyRequest: manager };
}
