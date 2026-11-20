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
