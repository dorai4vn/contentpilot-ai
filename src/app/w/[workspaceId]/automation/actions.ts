"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { automationModeSchema } from "@/lib/sports-news/automation-mode";
import { sportsControlTarget } from "@/lib/sports-news/control-target";
import { createClient } from "@/lib/supabase/server";
import { loadWorkspace } from "../../_lib/load";

const modeSchema = automationModeSchema;

const scoringSchema = z.object({
  threshold: z.coerce.number().min(0).max(10).refine((value) => Number.isInteger(value * 10)),
  reach: z.coerce.number().int().min(0).max(100),
  importance: z.coerce.number().int().min(0).max(100),
  freshness: z.coerce.number().int().min(0).max(100),
  engagement: z.coerce.number().int().min(0).max(100),
  fallback: z.enum(["highest", "strict"]),
}).refine((value) => value.reach + value.importance + value.freshness + value.engagement === 100);

type Limits = { dailyQuota: unknown; scanIntervalHours: unknown; postsPerScan: unknown };

async function update(workspaceId: string, mode: string, limits: Limits) {
  const path = `/w/${workspaceId}/automation`;
  const { workspace } = await loadWorkspace(workspaceId, path);
  if (workspace.role !== "owner" && workspace.role !== "admin") redirect(`${path}?error=forbidden`);
  const target = sportsControlTarget(workspace.id);
  if (!target) redirect(`${path}?error=unavailable`);
  const parsed = modeSchema.safeParse({ mode, ...limits });
  if (!parsed.success) redirect(`${path}?error=limits`);

  const client = await createClient();
  // Authorization and bounds are enforced again inside the SECURITY DEFINER function.
  const { error } = await client.rpc("set_sports_automation_mode", {
    p_workspace_id: target.workspaceId,
    p_project_id: target.projectId,
    p_destination_id: target.destinationId,
    p_mode: parsed.data.mode,
    p_daily_quota: parsed.data.dailyQuota,
    p_scan_interval_hours: parsed.data.scanIntervalHours,
    p_posts_per_scan: parsed.data.postsPerScan,
  });
  if (error) redirect(`${path}?error=save`);
  revalidatePath(path);
  redirect(`${path}?status=mode-${parsed.data.mode}`);
}

const limitsOf = (formData: FormData): Limits => ({
  dailyQuota: formData.get("dailyQuota"),
  scanIntervalHours: formData.get("scanIntervalHours"),
  postsPerScan: formData.get("postsPerScan"),
});

export async function setAutomationMode(formData: FormData) {
  const workspaceId = z.uuid().parse(formData.get("workspaceId"));
  await update(workspaceId, String(formData.get("mode")), limitsOf(formData));
}

/** Emergency stop: switch to Off immediately (no RSS, AI, image work or delivery). */
export async function emergencyStop(formData: FormData) {
  const workspaceId = z.uuid().parse(formData.get("workspaceId"));
  await update(workspaceId, "off", limitsOf(formData));
}

export async function saveScoring(formData: FormData) {
  const workspaceId = z.uuid().parse(formData.get("workspaceId"));
  const path = `/w/${workspaceId}/automation`;
  const { workspace } = await loadWorkspace(workspaceId, path);
  if (workspace.role !== "owner" && workspace.role !== "admin") redirect(`${path}?error=forbidden`);
  const target = sportsControlTarget(workspace.id);
  if (!target) redirect(`${path}?error=unavailable`);
  const parsed = scoringSchema.safeParse({
    threshold: formData.get("threshold"), reach: formData.get("reach"),
    importance: formData.get("importance"), freshness: formData.get("freshness"), engagement: formData.get("engagement"),
    fallback: formData.get("fallback"),
  });
  if (!parsed.success) redirect(`${path}?error=scoring`);
  const client = await createClient();
  const { error } = await client.rpc("set_sports_news_scoring_config", {
    p_workspace_id: target.workspaceId, p_project_id: target.projectId,
    p_threshold: parsed.data.threshold,
    p_reach_weight: parsed.data.reach,
    p_importance_weight: parsed.data.importance,
    p_freshness_weight: parsed.data.freshness,
    p_engagement_weight: parsed.data.engagement,
    p_fallback_mode: parsed.data.fallback,
  });
  if (error) redirect(`${path}?error=save`);
  revalidatePath(path);
  redirect(`${path}?status=scoring`);
}

export async function resetScoring(formData: FormData) {
  formData.set("threshold", "8");
  formData.set("reach", "30");
  formData.set("importance", "25");
  formData.set("freshness", "25");
  formData.set("engagement", "20");
  formData.set("fallback", "highest");
  await saveScoring(formData);
}
