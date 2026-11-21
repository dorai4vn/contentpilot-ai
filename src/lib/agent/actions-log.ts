import "server-only";

import { z } from "zod";

import { contentClient } from "@/lib/content/client";
import { parseContentInput, toContentError } from "@/lib/content/errors";
import { uuidSchema } from "@/lib/validation/content";
import type { AgentActionField, AgentActionKind, AgentActionStatus, Database } from "@/types/database";

import type { AgentToolContext, AgentToolEffect } from "./executor";
import { logSafeError, safeErrorInfo, safeLabel } from "@/lib/logging/safe-log";
import { AGENT_TOOL_NAMES } from "./tools";

/**
 * Data layer of the agent_actions log.
 *
 * Rows are built from what the SERVER observed when it executed a tool call
 * (status, error code, effect), never from the model's reply. Only ids, codes
 * and versions are stored: no titles, bodies, arguments, prompts or keys.
 *
 * Writing the log never throws and never changes the outcome of the action it
 * describes: the caller gets "recorded" or "failed" separately.
 */

export type AgentLogResult = "recorded" | "failed";

/** The parts of an agent action the log needs (structural, to avoid an import cycle with run.ts). */
export type LoggableAgentAction = {
  tool: string;
  kind: AgentActionKind;
  status: AgentActionStatus;
  code?: string;
  effect?: AgentToolEffect;
};

type AgentActionInsert = Database["public"]["Tables"]["agent_actions"]["Insert"];

/**
 * Error/skip codes that are only produced after the executor (or the loop) has
 * verified that the target belongs to the current workspace. For other failures
 * (not_found, invalid_input, read_required, …) the ids came straight from the
 * model and are not stored. The database independently enforces same-workspace
 * targets with composite foreign keys.
 */
const VERIFIED_TARGET_CODES = new Set([
  "version_conflict",
  "not_draft",
  "archived",
  "forbidden",
  "conflict_no_retry",
  "stale_version",
  // request_publish: produced after the post was found in the context workspace.
  "request_pending_exists",
  "post_published",
  "destination_disabled",
]);

const KNOWN_TOOLS = new Set<string>(AGENT_TOOL_NAMES);
const CODE_PATTERN = /^[a-z][a-z_]{0,39}$/;

/** Maps a server-observed action to a log row (pure; exported for tests). */
export function toAgentActionRow(
  ctx: AgentToolContext,
  turnId: string,
  action: LoggableAgentAction,
): AgentActionInsert {
  const success = action.status === "success";
  const effect = action.effect;
  const targetsVerified = success || (action.code !== undefined && VERIFIED_TARGET_CODES.has(action.code));
  const errorCode = success ? null : action.code && CODE_PATTERN.test(action.code) ? action.code : "unknown";
  const isUpdate = action.kind === "update";

  return {
    workspace_id: ctx.workspaceId,
    turn_id: turnId,
    tool: KNOWN_TOOLS.has(action.tool) ? action.tool : "unknown",
    kind: action.kind,
    status: action.status,
    error_code: errorCode,
    project_id: targetsVerified ? (effect?.projectId ?? null) : null,
    post_id: targetsVerified ? (effect?.postId ?? null) : null,
    version_before: success && isUpdate ? (effect?.versionBefore ?? null) : null,
    version_after: success ? (effect?.versionAfter ?? null) : null,
    fields: success && isUpdate && effect?.fields?.length ? (effect.fields as AgentActionField[]) : null,
    // Only a successful publish request names its request; the database checks it
    // is a real agent request of this user, turn, post and version.
    request_id: success && action.kind === "publish_request" ? (effect?.requestId ?? null) : null,
  };
}

/** Records one action as the signed-in user (RLS). Never throws. */
export async function recordAgentAction(
  ctx: AgentToolContext,
  turnId: string,
  action: LoggableAgentAction,
): Promise<AgentLogResult> {
  try {
    const { supabase, user } = await contentClient();
    if (user.id !== ctx.userId) return "failed";
    const { error } = await supabase.from("agent_actions").insert(toAgentActionRow(ctx, turnId, action));
    if (error) {
      logSafeError("agent log", {
        event: "record_failed",
        tool: safeLabel(action.tool),
        reason: toContentError(error).code,
        ...safeErrorInfo(error),
      });
      return "failed";
    }
    return "recorded";
  } catch (error) {
    logSafeError("agent log", { event: "record_failed", tool: safeLabel(action.tool), ...safeErrorInfo(error) });
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Reading the log (for the chat UI)
// ---------------------------------------------------------------------------

export type AgentActionLogEntry = {
  id: string;
  turnId: string;
  userId: string | null;
  tool: string;
  kind: AgentActionKind;
  status: AgentActionStatus;
  errorCode: string | null;
  projectId: string | null;
  postId: string | null;
  versionBefore: number | null;
  versionAfter: number | null;
  fields: AgentActionField[] | null;
  requestId: string | null;
  createdAt: string;
};

const listSchema = z.strictObject({
  workspaceId: uuidSchema,
  limit: z.number().int().min(1).max(100).optional().default(30),
});

const LOG_COLUMNS =
  "id, turn_id, user_id, tool, kind, status, error_code, project_id, post_id, version_before, version_after, fields, request_id, created_at";

/** Most recent agent actions of a workspace (members only, via RLS). */
export async function listAgentActions(input: unknown): Promise<AgentActionLogEntry[]> {
  const { workspaceId, limit } = parseContentInput(listSchema, input);
  const { supabase } = await contentClient();
  const { data, error } = await supabase
    .from("agent_actions")
    .select(LOG_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw toContentError(error);
  return (data ?? []).map((row) => ({
    id: row.id,
    turnId: row.turn_id,
    userId: row.user_id,
    tool: row.tool,
    kind: row.kind,
    status: row.status,
    errorCode: row.error_code,
    projectId: row.project_id,
    postId: row.post_id,
    versionBefore: row.version_before,
    versionAfter: row.version_after,
    fields: row.fields,
    requestId: row.request_id,
    createdAt: row.created_at,
  }));
}
