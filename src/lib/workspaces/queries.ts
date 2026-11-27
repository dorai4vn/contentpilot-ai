import "server-only";

import type { CurrentUser } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import type { WorkspaceRole } from "@/types/database";

export type WorkspaceSummary = {
  id: string;
  name: string;
  role: WorkspaceRole;
  createdAt: string;
};

/**
 * Workspaces the user belongs to. Runs as the user, so RLS guarantees that only
 * their own memberships are returned even without the explicit user_id filter.
 */
export async function listMyWorkspaces(user: CurrentUser): Promise<WorkspaceSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("role, workspaces!inner(id, name, created_at)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error("Could not load workspaces");
  }

  return (data ?? []).map((row) => ({
    id: row.workspaces.id,
    name: row.workspaces.name,
    role: row.role,
    createdAt: row.workspaces.created_at,
  }));
}

/**
 * Creates a workspace; the database trigger makes the caller its owner.
 * The id is generated here and the insert uses no RETURNING clause, because the
 * row only becomes visible to the caller after the owner membership exists.
 */
export async function createWorkspace(name: string): Promise<{ id: string }> {
  const supabase = await createClient();
  const id = crypto.randomUUID();
  const { error } = await supabase.from("workspaces").insert({ id, name });
  if (error) {
    throw new Error("Could not create workspace");
  }
  return { id };
}

/**
 * The workspace with the caller's role, or null when the caller is not a member
 * (RLS also hides it). Used by content pages to decide which actions to show;
 * the database still enforces every permission on its own.
 */
export async function getMyWorkspace(user: CurrentUser, workspaceId: string): Promise<WorkspaceSummary | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("role, workspaces!inner(id, name, created_at)")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    throw new Error("Could not load workspace");
  }
  if (!data) return null;
  return { id: data.workspaces.id, name: data.workspaces.name, role: data.role, createdAt: data.workspaces.created_at };
}

/**
 * Renames a workspace. Only `name` is written (id, created_by and membership are
 * untouched). Runs as the user: RLS allows owners/admins only. A blocked update
 * affects zero rows without an error, so the returned row is checked.
 */
export async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("workspaces").update({ name }).eq("id", workspaceId).select("id");
  if (error) {
    throw new Error("Could not rename workspace");
  }
  if (!data || data.length !== 1) {
    throw new Error("Workspace rename not permitted");
  }
}

export type WorkspaceMemberRole = { userId: string; role: WorkspaceRole };

/**
 * Members of a workspace with their roles (RLS: visible to fellow members only).
 * Used to label who requested / decided a publish request. Emails are not
 * readable by other members, so the UI shows "Bạn" or the member's role.
 */
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberRole[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId)
    .limit(500);
  if (error) {
    throw new Error("Could not load workspace members");
  }
  return (data ?? []).map((row) => ({ userId: row.user_id, role: row.role }));
}
