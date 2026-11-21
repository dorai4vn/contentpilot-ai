import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// Data layer mocked; the REAL executor and agent loop run on top of it.
const mocks = vi.hoisted(() => ({
  getMyWorkspace: vi.fn(),
  getPost: vi.fn(),
  createPost: vi.fn(),
  getProject: vi.fn(),
  getPublishingDestination: vi.fn(),
  listPublishingDestinations: vi.fn(),
  requestPostPublish: vi.fn(),
  approvePublishRequest: vi.fn(),
  recordAgentAction: vi.fn(),
}));
vi.mock("./actions-log", () => ({ recordAgentAction: mocks.recordAgentAction }));
vi.mock("@/lib/workspaces/queries", () => ({ getMyWorkspace: mocks.getMyWorkspace }));
vi.mock("@/lib/content/posts", () => ({ getPost: mocks.getPost, createPost: mocks.createPost, listPosts: vi.fn(), patchPost: vi.fn() }));
vi.mock("@/lib/content/projects", () => ({ getProject: mocks.getProject, listProjects: vi.fn() }));
vi.mock("@/lib/publishing/destinations", () => ({
  getPublishingDestination: mocks.getPublishingDestination,
  listPublishingDestinations: mocks.listPublishingDestinations,
}));
vi.mock("@/lib/content/publish-requests", () => ({
  requestPostPublish: mocks.requestPostPublish,
  approvePublishRequest: mocks.approvePublishRequest,
}));

import { type AgentToolContext, createAgentToolContext } from "./executor";
import { AGENT_LIMITS } from "./limits";
import type { AgentModel, AgentModelResponse } from "./llm";
import { AGENT_REPLIES, runAgent } from "./run";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "u@example.test" };
const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";
const DEST = "88888888-8888-4888-8888-888888888888";
const REQUEST = "66666666-6666-4666-8666-666666666666";

const post = {
  id: POST,
  workspaceId: WS,
  projectId: PROJECT,
  title: "Hello",
  body: "Body",
  status: "draft" as const,
  scheduledFor: null,
  version: 3,
  lastChangeSource: "user" as const,
  archivedAt: null,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:05:00Z",
  createdBy: USER.id,
  updatedBy: USER.id,
};

let seq = 0;
const call = (name: string, args: unknown) => {
  seq += 1;
  return { callId: `call_${seq}`, name, arguments: JSON.stringify(args) };
};
const tools = (...calls: AgentModelResponse["toolCalls"]): AgentModelResponse => ({
  text: "",
  toolCalls: calls,
  outputItems: calls.map((c) => ({ type: "function_call", call_id: c.callId, name: c.name, arguments: c.arguments })),
});
const say = (text: string): AgentModelResponse => ({ text, toolCalls: [], outputItems: [] });
function scripted(steps: AgentModelResponse[]): AgentModel {
  return {
    async respond() {
      const step = steps.shift();
      if (!step) throw new Error("no more steps");
      return step;
    },
  };
}
const ask = [{ role: "user" as const, content: "Gửi yêu cầu xuất bản bài Hello lên Nội bộ" }];
const requestArgs = (version = 3) => ({ post_id: POST, expected_version: version, destination_id: DEST, reason: null });

let ctx: AgentToolContext;
beforeEach(async () => {
  vi.clearAllMocks();
  seq = 0;
  mocks.getMyWorkspace.mockResolvedValue({ id: WS, name: "WS", role: "owner", createdAt: "x" });
  ctx = await createAgentToolContext(USER, WS);
  mocks.getPost.mockResolvedValue(post);
  mocks.getProject.mockResolvedValue({ id: PROJECT, workspaceId: WS, archivedAt: null, name: "Blog" });
  mocks.createPost.mockImplementation(async () => ({ ...post, id: crypto.randomUUID(), version: 1 }));
  mocks.getPublishingDestination.mockResolvedValue({ id: DEST, workspaceId: WS, kind: "internal", name: "Nội bộ", targetRef: null, status: "active" });
  mocks.requestPostPublish.mockResolvedValue({ id: REQUEST, postId: POST, postVersion: 3, destinationId: DEST, status: "pending" });
  mocks.recordAgentAction.mockResolvedValue("recorded");
});

describe("request_publish in the agent loop", () => {
  it("after get_post: one pending request with the server's turn id, counted as a write, logged with the request", async () => {
    const result = await runAgent({
      ctx,
      model: scripted([
        tools(call("get_post", { post_id: POST })),
        tools(call("request_publish", requestArgs())),
        say("Đã gửi yêu cầu xuất bản phiên bản 3 lên đích Nội bộ; yêu cầu đang chờ duyệt."),
      ]),
      messages: ask,
    });
    expect(result.stopReason).toBe("completed");
    expect(result.writes).toBe(1);
    expect(mocks.requestPostPublish).toHaveBeenCalledTimes(1);
    expect(mocks.requestPostPublish.mock.calls[0]![1]).toEqual({ source: "agent", agentTurnId: result.turnId, workspaceId: WS });
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
    const action = result.actions.find((a) => a.tool === "request_publish")!;
    expect(action).toMatchObject({ kind: "publish_request", status: "success", effect: { requestId: REQUEST, versionAfter: 3 } });
    // The log receives the same turn id the request was made with.
    const logged = mocks.recordAgentAction.mock.calls.find(([, , a]) => a.tool === "request_publish")!;
    expect(logged[1]).toBe(result.turnId);
  });

  it("without reading the post first: read_required, nothing requested", async () => {
    const result = await runAgent({
      ctx,
      model: scripted([tools(call("request_publish", requestArgs())), say("…")]),
      messages: ask,
    });
    expect(result.actions[0]).toMatchObject({ tool: "request_publish", status: "skipped", code: "read_required" });
    expect(mocks.requestPostPublish).not.toHaveBeenCalled();
  });

  it("with another version than the one read: stale_version, nothing requested", async () => {
    const result = await runAgent({
      ctx,
      model: scripted([tools(call("get_post", { post_id: POST })), tools(call("request_publish", requestArgs(2))), say("…")]),
      messages: ask,
    });
    expect(result.actions[1]).toMatchObject({ status: "skipped", code: "stale_version" });
    expect(mocks.requestPostPublish).not.toHaveBeenCalled();
  });

  it("counts toward the write budget", async () => {
    const creates = Array.from({ length: AGENT_LIMITS.maxWrites }, (_, i) =>
      call("create_post", { project_id: PROJECT, title: `Bài ${i}`, body: "x", scheduled_for: null }),
    );
    const result = await runAgent({
      ctx,
      model: scripted([
        tools(call("get_post", { post_id: POST })),
        tools(...creates, call("request_publish", requestArgs())),
        say("…"),
      ]),
      messages: ask,
    });
    expect(result.writes).toBe(AGENT_LIMITS.maxWrites);
    expect(result.actions.at(-1)).toMatchObject({ tool: "request_publish", status: "skipped", code: "write_limit" });
    expect(mocks.requestPostPublish).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("write_limit");
  });

  it("a failed audit write after the request was created is reported, never retried", async () => {
    mocks.recordAgentAction.mockImplementation(async (_ctx, _turn, action) => (action.tool === "request_publish" ? "failed" : "recorded"));
    const result = await runAgent({
      ctx,
      model: scripted([tools(call("get_post", { post_id: POST })), tools(call("request_publish", requestArgs())), say("Đã gửi yêu cầu.")]),
      messages: ask,
    });
    expect(mocks.requestPostPublish).toHaveBeenCalledTimes(1);
    expect(result.actions.find((a) => a.tool === "request_publish")).toMatchObject({ status: "success", log: "failed" });
    expect(result.logging).toEqual({ recorded: 1, failed: 1 });
    expect(result.reply).toContain(AGENT_REPLIES.logFailed);
  });

  it("an error (e.g. a pending request already exists) is reported once, no retry", async () => {
    const { ContentError } = await import("@/lib/content/errors");
    mocks.requestPostPublish.mockRejectedValue(new ContentError("request_pending_exists"));
    const result = await runAgent({
      ctx,
      model: scripted([tools(call("get_post", { post_id: POST })), tools(call("request_publish", requestArgs())), say("…")]),
      messages: ask,
    });
    expect(mocks.requestPostPublish).toHaveBeenCalledTimes(1);
    expect(result.actions[1]).toMatchObject({ status: "error", code: "request_pending_exists" });
  });
});
