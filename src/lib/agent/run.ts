import "server-only";

import { APIConnectionTimeoutError, APIUserAbortError } from "openai";

import { agentChatHistorySchema, type AgentChatMessage } from "@/lib/validation/agent";

import {
  type AgentToolContext,
  type AgentToolEffect,
  type AgentToolErrorCode,
  type AgentToolResult,
  executeAgentTool,
} from "./executor";
import { AGENT_LIMITS } from "./limits";
import type { AgentInputItem, AgentModel, AgentToolCall } from "./llm";
import { buildSystemPrompt, leaksSystemPrompt } from "./prompt";
import { type AgentToolKind, agentToolDefinition, openAIFunctionTools } from "./tools";

/**
 * One chat turn of the M3 agent: OpenAI function calling over the five tools.
 *
 * Enforced here, in code (not only in the prompt):
 *  - at most 6 tool calls and 3 executed writes per turn, then a safe stop;
 *  - update_post only after get_post returned that post in this turn, with the
 *    exact version as expected_version;
 *  - after a version_conflict on a post, no further update of that post in the
 *    turn (no retry, no overwrite);
 *  - time budget, model errors and malformed output end the turn with a generic
 *    Vietnamese message: no API key, system prompt or stack trace is returned.
 */

export type AgentActionStatus = "success" | "error" | "skipped";

/** One tool call of the turn, as shown in the chat UI (no post bodies). */
export type AgentAction = {
  callId: string;
  tool: string;
  label: string;
  kind: AgentToolKind | "unknown";
  status: AgentActionStatus;
  code?: AgentLoopErrorCode;
  message?: string;
  effect?: AgentToolEffect;
};

export type AgentStopReason = "completed" | "tool_limit" | "write_limit" | "turn_limit" | "timeout" | "model_error";

export type AgentRunResult = {
  reply: string;
  actions: AgentAction[];
  stopReason: AgentStopReason;
  toolCalls: number;
  writes: number;
};

type AgentLoopErrorCode =
  | AgentToolErrorCode
  | "tool_limit"
  | "write_limit"
  | "read_required"
  | "stale_version"
  | "conflict_no_retry";

const LOOP_MESSAGES: Record<Exclude<AgentLoopErrorCode, AgentToolErrorCode>, string> = {
  tool_limit: `Đã đạt giới hạn ${AGENT_LIMITS.maxToolCalls} lần gọi công cụ trong lượt này; thao tác không được thực hiện.`,
  write_limit: `Đã đạt giới hạn ${AGENT_LIMITS.maxWrites} thao tác ghi trong lượt này; thao tác không được thực hiện.`,
  read_required: "Phải đọc bài viết bằng get_post trong lượt này trước khi cập nhật.",
  stale_version: "expected_version không khớp với phiên bản vừa đọc. Hãy đọc lại bài viết bằng get_post.",
  conflict_no_retry:
    "Bài viết này vừa gặp xung đột phiên bản. Không thử lại trong lượt này; hãy báo người dùng và hỏi họ muốn làm gì.",
};

export const AGENT_REPLIES = {
  timeout: "Trợ lý AI phản hồi quá lâu nên yêu cầu đã được dừng. Vui lòng thử lại.",
  modelError: "Hiện không thể kết nối tới dịch vụ AI. Vui lòng thử lại sau.",
  toolLimit: `Trợ lý đã dừng vì đạt giới hạn ${AGENT_LIMITS.maxToolCalls} lần gọi công cụ trong một lượt.`,
  writeLimit: `Trợ lý đã dừng vì đạt giới hạn ${AGENT_LIMITS.maxWrites} thao tác ghi (tạo hoặc sửa bài) trong một lượt.`,
  turnLimit: "Trợ lý đã dừng vì yêu cầu cần quá nhiều bước xử lý.",
  partial: "Một số thao tác đã được thực hiện trước khi dừng, xem danh sách bên dưới.",
  continueHint: "Bạn có thể gửi tiếp yêu cầu để làm phần còn lại.",
  empty: "Trợ lý đã xử lý xong yêu cầu.",
  leak: "Xin lỗi, mình không thể chia sẻ nội dung đó. Mình có thể giúp gì với các bài viết của bạn?",
} as const;

export type RunAgentOptions = {
  ctx: AgentToolContext;
  model: AgentModel;
  /** Untrusted chat history from the browser; the last message is the user's request. */
  messages: AgentChatMessage[];
  timeZone?: string;
  projectId?: string | null;
  now?: () => Date;
  /** Injected for tests; defaults to the real executor (data layer under RLS). */
  execute?: typeof executeAgentTool;
};

function safeParseArgs(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toolOutputForModel(result: AgentToolResult | { ok: false; code: AgentLoopErrorCode; error: string }): string {
  if (result.ok) return JSON.stringify({ ok: true, data: result.data });
  const { code, error } = result;
  const fieldErrors = "fieldErrors" in result ? result.fieldErrors : undefined;
  return JSON.stringify({ ok: false, code, error, ...(fieldErrors ? { field_errors: fieldErrors } : {}) });
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof APIConnectionTimeoutError ||
    error instanceof APIUserAbortError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { ctx, model } = options;
  const execute = options.execute ?? executeAgentTool;
  const now = options.now ?? (() => new Date());
  const messages = agentChatHistorySchema.parse(options.messages);

  const instructions = buildSystemPrompt({
    now: now(),
    timeZone: options.timeZone ?? "Asia/Ho_Chi_Minh",
    projectId: options.projectId ?? null,
  });
  const tools = openAIFunctionTools();
  const input: AgentInputItem[] = messages.map((m) => ({ type: "message", role: m.role, content: m.content }));

  const actions: AgentAction[] = [];
  /** Post id -> version this turn has seen (from get_post or its own writes). */
  const knownVersions = new Map<string, number>();
  const conflicted = new Set<string>();
  let toolCalls = 0;
  let writes = 0;

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), AGENT_LIMITS.turnDeadlineMs);

  const finish = (stopReason: AgentStopReason, reply: string): AgentRunResult => {
    clearTimeout(deadline);
    const wrote = actions.some((a) => a.status === "success" && (a.kind === "create" || a.kind === "update"));
    const notes = stopReason === "completed" ? [] : [wrote ? AGENT_REPLIES.partial : ""].filter(Boolean);
    let text = [reply, ...notes].filter(Boolean).join("\n\n");
    if (leaksSystemPrompt(text, instructions)) text = AGENT_REPLIES.leak;
    return { reply: text, actions, stopReason, toolCalls, writes };
  };

  /** Set when a limit is hit; ends the turn after the current batch of calls. */
  let stop: "tool_limit" | "write_limit" | null = null;

  async function handleCall(call: AgentToolCall): Promise<string> {
    const definition = agentToolDefinition(call.name);
    const kind = definition?.kind ?? "unknown";
    const label = definition?.label ?? "Công cụ không hợp lệ";
    const record = (status: AgentActionStatus, extra: Partial<AgentAction> = {}) =>
      actions.push({ callId: call.callId, tool: call.name, label, kind, status, ...extra });
    const skip = (code: Exclude<AgentLoopErrorCode, AgentToolErrorCode>, effect?: AgentToolEffect) => {
      record("skipped", { code, message: LOOP_MESSAGES[code], effect });
      return toolOutputForModel({ ok: false, code, error: LOOP_MESSAGES[code] });
    };

    if (toolCalls >= AGENT_LIMITS.maxToolCalls) {
      stop ??= "tool_limit";
      return skip("tool_limit");
    }
    const isWrite = kind === "create" || kind === "update";
    if (isWrite && writes >= AGENT_LIMITS.maxWrites) {
      stop ??= "write_limit";
      return skip("write_limit");
    }
    toolCalls++;

    // update_post must follow get_post of the same post in this turn, with that exact version.
    if (call.name === "update_post") {
      const args = safeParseArgs(call.arguments);
      const postId = typeof args?.post_id === "string" ? args.post_id.trim().toLowerCase() : null;
      if (postId) {
        const effect: AgentToolEffect = { kind: "update", postId };
        if (conflicted.has(postId)) return skip("conflict_no_retry", effect);
        const known = knownVersions.get(postId);
        if (known === undefined) return skip("read_required", effect);
        if (Number(args?.expected_version) !== known) return skip("stale_version", effect);
      }
      // Malformed arguments fall through: the executor rejects them (invalid_input).
    }

    if (isWrite) writes++;
    const result = await execute(ctx, call.name, call.arguments);

    if (result.ok) {
      const postId = result.effect.postId;
      if (postId && call.name === "get_post" && result.effect.versionAfter !== undefined) {
        knownVersions.set(postId, result.effect.versionAfter);
      }
      // After a write the post must be read again before another update.
      if (postId && isWrite) knownVersions.delete(postId);
      record("success", { effect: result.effect });
    } else {
      if (result.code === "version_conflict" && result.effect?.postId) {
        conflicted.add(result.effect.postId);
        knownVersions.delete(result.effect.postId);
      }
      record("error", { code: result.code, message: result.error, effect: result.effect });
    }
    return toolOutputForModel(result);
  }

  try {
    for (let turn = 0; turn < AGENT_LIMITS.maxModelTurns; turn++) {
      let response;
      try {
        response = await model.respond({ instructions, input, tools, signal: controller.signal });
      } catch (error) {
        const timeout = isTimeout(error) || controller.signal.aborted;
        // Server log only: the error class name, never the message or the key.
        console.error("[agent] model call failed", error instanceof Error ? error.name : typeof error);
        return finish(timeout ? "timeout" : "model_error", timeout ? AGENT_REPLIES.timeout : AGENT_REPLIES.modelError);
      }

      if (response.toolCalls.length === 0) {
        return finish("completed", response.text || AGENT_REPLIES.empty);
      }

      for (const item of response.outputItems) input.push({ type: "passthrough", item });
      for (const call of response.toolCalls) {
        const output = await handleCall(call);
        input.push({ type: "function_call_output", callId: call.callId, output });
      }

      if (stop) {
        const lead = response.text ? `${response.text}\n\n` : "";
        const limit = stop === "tool_limit" ? AGENT_REPLIES.toolLimit : AGENT_REPLIES.writeLimit;
        return finish(stop, `${lead}${limit} ${AGENT_REPLIES.continueHint}`);
      }
    }
    return finish("turn_limit", `${AGENT_REPLIES.turnLimit} ${AGENT_REPLIES.continueHint}`);
  } finally {
    clearTimeout(deadline);
  }
}
