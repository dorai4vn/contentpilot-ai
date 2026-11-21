import { z } from "zod";

import { AGENT_CHAT_LIMITS } from "@/lib/validation/agent";

/**
 * Browser-side client for POST /api/agent. Pure module (no server imports).
 *
 * The request body contains exactly what the API schema accepts: workspaceId,
 * projectId, messages (role + content) and timeZone. Never a user id, role or
 * key: identity comes from the session cookie on the server.
 */

export type ChatTurnMessage = { role: "user" | "assistant"; content: string };

export type AgentRequestBody = {
  workspaceId: string;
  projectId: string | null;
  messages: ChatTurnMessage[];
  timeZone: string;
};

/** The browser's IANA time zone, or Vietnam time when unavailable. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Ho_Chi_Minh";
  } catch {
    return "Asia/Ho_Chi_Minh";
  }
}

/**
 * Builds the request from the session chat history plus the new question:
 * at most 20 messages, ending with the user's, each within the length limit
 * (long assistant replies are shortened; they are context only).
 */
export function buildAgentRequest(input: {
  workspaceId: string;
  projectId: string | null;
  history: ChatTurnMessage[];
  text: string;
  timeZone: string;
}): AgentRequestBody {
  const max = AGENT_CHAT_LIMITS.maxMessageLength;
  const clean = input.history
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim() !== "")
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, max) }));
  const messages = [...clean, { role: "user" as const, content: input.text.trim().slice(0, max) }].slice(
    -AGENT_CHAT_LIMITS.maxMessages,
  );
  return { workspaceId: input.workspaceId, projectId: input.projectId, messages, timeZone: input.timeZone };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

const effectSchema = z.object({
  kind: z.enum(["read", "create", "update", "publish_request"]),
  projectId: z.string().optional(),
  postId: z.string().optional(),
  versionBefore: z.number().optional(),
  versionAfter: z.number().optional(),
  requestId: z.string().optional(),
  destinationId: z.string().optional(),
  fields: z.array(z.enum(["title", "body", "scheduled_for"])).optional(),
});

const actionSchema = z.object({
  tool: z.string(),
  label: z.string(),
  kind: z.enum(["read", "create", "update", "publish_request", "unknown"]),
  status: z.enum(["success", "error", "skipped"]),
  code: z.string().optional(),
  message: z.string().optional(),
  effect: effectSchema.optional(),
  log: z.enum(["recorded", "failed"]),
});

const successSchema = z.object({
  turnId: z.string(),
  reply: z.string(),
  actions: z.array(actionSchema),
  stopReason: z.enum(["completed", "tool_limit", "write_limit", "turn_limit", "timeout", "model_error"]),
  stats: z.object({
    toolCalls: z.number(),
    writes: z.number(),
    logging: z.object({ recorded: z.number(), failed: z.number() }),
  }),
});

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export type AgentApiAction = z.infer<typeof actionSchema>;
export type AgentApiSuccess = z.infer<typeof successSchema>;

export type AgentCallErrorKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "rate_limited"
  | "not_configured"
  | "timeout"
  | "service"
  | "network"
  | "server";

export type AgentCallResult =
  | { ok: true; data: AgentApiSuccess }
  | { ok: false; kind: AgentCallErrorKind; message: string; retryAfterSeconds?: number };

export const AGENT_CLIENT_MESSAGES: Record<AgentCallErrorKind, string> = {
  unauthenticated: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  forbidden: "Bạn không có quyền dùng Trợ lý AI trong không gian làm việc này.",
  not_found: "Không tìm thấy dự án đã chọn.",
  invalid: "Yêu cầu không hợp lệ. Hãy rút ngắn tin nhắn hoặc bắt đầu cuộc trò chuyện mới.",
  rate_limited: "Bạn gửi yêu cầu quá nhanh. Vui lòng đợi một chút rồi thử lại.",
  not_configured: "Trợ lý AI chưa được cấu hình trên hệ thống.",
  timeout: "Trợ lý AI phản hồi quá lâu. Vui lòng thử lại.",
  service: "Dịch vụ AI tạm thời không phản hồi. Vui lòng thử lại sau.",
  network: "Không kết nối được tới máy chủ. Hãy kiểm tra mạng rồi thử lại.",
  server: "Đã có lỗi xảy ra. Vui lòng thử lại.",
};

function kindForStatus(status: number, code: string | undefined): AgentCallErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 503) return code === "agent_not_configured" ? "not_configured" : "service";
  if (status === 504) return "timeout";
  if (status === 502) return "service";
  if (status >= 400 && status < 500) return "invalid";
  return "server";
}

/** Slightly above the route's maxDuration (60 s). */
export const AGENT_CLIENT_TIMEOUT_MS = 70_000;

export async function callAgent(
  body: AgentRequestBody,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AgentCallResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? AGENT_CLIENT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    const kind: AgentCallErrorKind = controller.signal.aborted ? "timeout" : "network";
    return { ok: false, kind, message: AGENT_CLIENT_MESSAGES[kind] };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) {
    const parsed = successSchema.safeParse(payload);
    if (parsed.success) return { ok: true, data: parsed.data };
    return { ok: false, kind: "server", message: AGENT_CLIENT_MESSAGES.server };
  }

  const error = errorSchema.safeParse(payload);
  const kind = kindForStatus(response.status, error.success ? error.data.error.code : undefined);
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    ok: false,
    kind,
    // Server messages are generic Vietnamese texts; fall back to ours otherwise.
    message: error.success ? error.data.error.message : AGENT_CLIENT_MESSAGES[kind],
    ...(kind === "rate_limited" && Number.isFinite(retryAfter) && retryAfter > 0
      ? { retryAfterSeconds: Math.min(Math.ceil(retryAfter), 600) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, tested)
// ---------------------------------------------------------------------------

/** True when something was written before the assistant stopped early. */
export function isPartialResult(data: Pick<AgentApiSuccess, "actions" | "stopReason">): boolean {
  return (
    data.stopReason !== "completed" &&
    data.actions.some(
      (a) => a.status === "success" && (a.kind === "create" || a.kind === "update" || a.kind === "publish_request"),
    )
  );
}
