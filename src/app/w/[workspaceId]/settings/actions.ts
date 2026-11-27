"use server";

import { revalidatePath } from "next/cache";

import { workspaceNameSchema } from "@/lib/validation/auth";
import { renameWorkspace } from "@/lib/workspaces/queries";

import { loadWorkspace } from "../../_lib/load";

export type RenameWorkspaceState = { error?: string; ok?: boolean; name?: string };

/**
 * Server Actions are public endpoints: re-verify the session and the caller's
 * role in the target workspace (a malformed or foreign id -> notFound), validate
 * the name, then update as the user so RLS is the final authority.
 */
export async function renameWorkspaceAction(
  workspaceId: string,
  _prev: RenameWorkspaceState,
  formData: FormData,
): Promise<RenameWorkspaceState> {
  const { workspace, permissions } = await loadWorkspace(workspaceId, `/w/${workspaceId}/settings`);
  if (!permissions.manageWorkspace) {
    return { error: "Bạn không có quyền đổi tên không gian làm việc này." };
  }

  const parsed = workspaceNameSchema.safeParse(formData.get("name") ?? "");
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Tên không hợp lệ." };
  }

  try {
    await renameWorkspace(workspace.id, parsed.data);
  } catch {
    return { error: "Không thể đổi tên không gian làm việc. Vui lòng thử lại." };
  }

  revalidatePath(`/w/${workspace.id}`, "layout");
  revalidatePath("/dashboard");
  return { ok: true, name: parsed.data };
}
