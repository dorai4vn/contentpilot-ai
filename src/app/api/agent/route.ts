import { isAgentConfigured } from "@/lib/agent/config";
import { createAgentToolContext } from "@/lib/agent/executor";
import { createOpenAIModel } from "@/lib/agent/llm";
import { agentRateLimiter } from "@/lib/agent/rate-limit";
import { logSafeError, safeErrorInfo } from "@/lib/logging/safe-log";
import { type AgentAction, runAgent } from "@/lib/agent/run";
import { getCurrentUser } from "@/lib/auth/dal";
import { ContentError, contentFieldErrors } from "@/lib/content/errors";
import { getProject } from "@/lib/content/projects";
import { MissingConfigurationError } from "@/lib/env";
import { agentRequestSchema } from "@/lib/validation/agent";

/**
 * POST /api/agent — one chat turn with the AI agent.
 *
 * Order of checks (nothing reaches OpenAI before all of them pass):
 *   same-origin JSON request → signed-in user (401) → body size and strict
 *   validation (400/413) → agent configured (503) → per-user rate limit (429)
 *   → workspace membership (403) → project in that workspace (404) → run.
 * Identity and permissions come only from the Supabase session; the body
 * cannot carry a user id or a role (strict schema). The response contains the
 * reply, the actions the server performed and counters — never the API key,
 * the system prompt, stack traces or database errors.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The agent loop stops after 45 s; this leaves time for auth, membership checks and logging. */
export const maxDuration = 60;

/** 20 messages × 4,000 characters plus JSON overhead, with headroom for UTF-8. */
const MAX_BODY_BYTES = 256 * 1024;

type ErrorCode =
  | "unauthenticated"
  | "invalid_request"
  | "unsupported_media_type"
  | "payload_too_large"
  | "forbidden"
  | "not_found"
  | "agent_not_configured"
  | "rate_limited"
  | "service_unavailable"
  | "timeout"
  | "internal_error";

const ERRORS: Record<ErrorCode, { status: number; message: string }> = {
  unauthenticated: { status: 401, message: "Bạn cần đăng nhập để dùng Trợ lý AI." },
  invalid_request: { status: 400, message: "Yêu cầu không hợp lệ." },
  unsupported_media_type: { status: 415, message: "Yêu cầu phải có định dạng JSON." },
  payload_too_large: { status: 413, message: "Nội dung gửi lên quá lớn." },
  forbidden: { status: 403, message: "Bạn không có quyền dùng Trợ lý AI trong không gian làm việc này." },
  not_found: { status: 404, message: "Không tìm thấy dự án trong không gian làm việc này." },
  agent_not_configured: { status: 503, message: "Trợ lý AI chưa được cấu hình trên hệ thống." },
  rate_limited: { status: 429, message: "Bạn gửi yêu cầu quá nhanh. Vui lòng đợi một chút rồi thử lại." },
  service_unavailable: { status: 502, message: "Dịch vụ AI tạm thời không phản hồi. Vui lòng thử lại sau." },
  timeout: { status: 504, message: "Trợ lý AI phản hồi quá lâu. Vui lòng thử lại." },
  internal_error: { status: 500, message: "Đã có lỗi xảy ra. Vui lòng thử lại." },
};

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function errorResponse(
  code: ErrorCode,
  extra: { fieldErrors?: Partial<Record<string, string>>; headers?: Record<string, string> } = {},
) {
  const { status, message } = ERRORS[code];
  return Response.json(
    { error: { code, message, ...(extra.fieldErrors ? { fieldErrors: extra.fieldErrors } : {}) } },
    { status, headers: { ...NO_STORE, ...extra.headers } },
  );
}

/** Only the fields the UI needs; ids, codes and versions — no post content. */
function publicAction(action: AgentAction) {
  return {
    tool: action.tool,
    label: action.label,
    kind: action.kind,
    status: action.status,
    ...(action.code ? { code: action.code } : {}),
    ...(action.message ? { message: action.message } : {}),
    ...(action.effect ? { effect: action.effect } : {}),
    log: action.log ?? "failed",
  };
}

/** Rejects cross-site requests (defence in depth on top of SameSite cookies). */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true; // same-origin fetches may omit it; cookies are SameSite=Lax
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; code: ErrorCode }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, code: "payload_too_large" };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false, code: "payload_too_large" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, code: "invalid_request" };
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!isSameOrigin(request)) return errorResponse("forbidden");
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/json\b/i.test(contentType)) return errorResponse("unsupported_media_type");

    const user = await getCurrentUser();
    if (!user) return errorResponse("unauthenticated");

    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse(body.code);
    const parsed = agentRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse("invalid_request", { fieldErrors: contentFieldErrors(parsed.error) });
    }
    const { workspaceId, projectId, messages, timeZone } = parsed.data;

    if (!isAgentConfigured()) return errorResponse("agent_not_configured");

    const slot = agentRateLimiter.acquire(user.id);
    if (!slot.allowed) {
      return errorResponse("rate_limited", { headers: { "Retry-After": String(slot.retryAfterSeconds) } });
    }

    try {
      // Membership is checked from the session; a missing workspace and a
      // foreign one get the same answer.
      let ctx;
      try {
        ctx = await createAgentToolContext(user, workspaceId);
      } catch (error) {
        if (error instanceof ContentError) return errorResponse("forbidden");
        throw error;
      }

      if (projectId) {
        const project = await getProject({ projectId });
        if (!project || project.workspaceId !== ctx.workspaceId) return errorResponse("not_found");
      }

      const result = await runAgent({
        ctx,
        model: createOpenAIModel(),
        messages,
        timeZone: timeZone ?? "Asia/Ho_Chi_Minh",
        projectId: projectId ?? null,
      });

      // Nothing happened and the model failed: report it as an error status.
      if (result.actions.length === 0 && result.stopReason === "model_error") {
        return errorResponse("service_unavailable");
      }
      if (result.actions.length === 0 && result.stopReason === "timeout") {
        return errorResponse("timeout");
      }

      // Otherwise 200, so the UI can show every action that was performed.
      return Response.json(
        {
          turnId: result.turnId,
          reply: result.reply,
          actions: result.actions.map(publicAction),
          stopReason: result.stopReason,
          stats: { toolCalls: result.toolCalls, writes: result.writes, logging: result.logging },
        },
        { status: 200, headers: NO_STORE },
      );
    } finally {
      slot.release();
    }
  } catch (error) {
    if (error instanceof MissingConfigurationError) return errorResponse("agent_not_configured");
    // Server log: error class and code only (no message: it could contain user data).
    logSafeError("api/agent", { event: "unexpected_error", ...safeErrorInfo(error) });
    return errorResponse("internal_error");
  }
}
