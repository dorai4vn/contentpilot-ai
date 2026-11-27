"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { sportsControlTarget } from "@/lib/sports-news/control-target";
import { createClient } from "@/lib/supabase/server";
import { loadWorkspace } from "../../_lib/load";

const limits = z.object({
  hours: z.coerce.number().int().min(1).max(8),
  perSlot: z.coerce.number().int().min(1).max(10),
  perWindow: z.coerce.number().int().min(1).max(40),
}).refine((value) => value.perWindow >= value.perSlot);

async function update(workspaceId: string, enabled: boolean, formData?: FormData) {
  const path = `/w/${workspaceId}/automation`;
  const { workspace } = await loadWorkspace(workspaceId, path);
  if (workspace.role !== "owner" && workspace.role !== "admin") redirect(`${path}?error=forbidden`);
  const target = sportsControlTarget(workspace.id);
  if (!target) redirect(`${path}?error=unavailable`);
  const parsed = enabled ? limits.safeParse({
    hours: formData?.get("hours"), perSlot: formData?.get("perSlot"), perWindow: formData?.get("perWindow"),
  }) : limits.safeParse({ hours: 1, perSlot: 10, perWindow: 40 });
  if (!parsed.success) redirect(`${path}?error=limits`);

  const client = await createClient();
  const { error } = await client.rpc("set_sports_auto_publish_control", {
    p_workspace_id: target.workspaceId,
    p_project_id: target.projectId,
    p_destination_id: target.destinationId,
    p_enabled: enabled,
    p_hours: parsed.data.hours,
    p_slot_limit: parsed.data.perSlot,
    p_window_limit: parsed.data.perWindow,
  });
  if (error) redirect(`${path}?error=save`);
  revalidatePath(path);
  redirect(`${path}?status=${enabled ? "enabled" : "stopped"}`);
}

export async function enableAutomation(formData: FormData) {
  const workspaceId = z.uuid().parse(formData.get("workspaceId"));
  await update(workspaceId, true, formData);
}

export async function emergencyStop(formData: FormData) {
  const workspaceId = z.uuid().parse(formData.get("workspaceId"));
  await update(workspaceId, false);
}
