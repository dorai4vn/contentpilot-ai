"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/dal";
import { workspaceNameSchema } from "@/lib/validation/auth";
import { createWorkspace } from "@/lib/workspaces/queries";

export type CreateWorkspaceState = { error?: string; ok?: boolean };

export async function createWorkspaceAction(
  _prev: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  // Server Actions are public endpoints: always re-verify the session here.
  await requireUser();

  const parsed = workspaceNameSchema.safeParse(formData.get("name") ?? "");
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Tên không hợp lệ." };
  }

  try {
    await createWorkspace(parsed.data);
  } catch {
    return { error: "Không thể tạo không gian làm việc. Vui lòng thử lại." };
  }

  revalidatePath("/dashboard");
  return { ok: true };
}
