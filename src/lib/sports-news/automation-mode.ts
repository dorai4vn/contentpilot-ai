import { z } from "zod";

export const AUTOMATION_MODES = ["off", "semi", "auto"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];
export const AUTOMATION_DAILY_QUOTA_MAX = 120;
export const AUTOMATION_DAILY_QUOTA_DEFAULT = 40;

export const automationModeSchema = z.object({
  mode: z.enum(AUTOMATION_MODES),
  dailyQuota: z.coerce.number().int().min(1).max(AUTOMATION_DAILY_QUOTA_MAX),
});

/** Thrown at a safe checkpoint when the owner switched automation Off while a run was in flight. */
export class AutomationOffError extends Error {
  constructor() {
    super("automation_off");
  }
}

type ModeRow = { mode: string; daily_quota: number };
type ModeClient = {
  rpc: (name: "get_sports_automation_mode", args: { p_workspace_id: string; p_project_id: string }) =>
    PromiseLike<{ data: ModeRow[] | null; error: unknown }>;
};

/** Fail closed: an unreadable or unexpected mode is treated as Off. Absent configuration is Semi (database default). */
export async function readAutomationMode(client: ModeClient, workspaceId: string, projectId: string): Promise<AutomationMode> {
  const { data, error } = await client.rpc("get_sports_automation_mode", { p_workspace_id: workspaceId, p_project_id: projectId });
  if (error || !data?.[0]) return "off";
  const parsed = z.enum(AUTOMATION_MODES).safeParse(data[0].mode);
  return parsed.success ? parsed.data : "off";
}

/** Safe checkpoint: call before every AI call, image fetch and external delivery. */
export async function assertAutomationNotOff(client: ModeClient, workspaceId: string, projectId: string) {
  if (await readAutomationMode(client, workspaceId, projectId) === "off") throw new AutomationOffError();
}
