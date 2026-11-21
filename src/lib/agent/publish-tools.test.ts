import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  getMyWorkspace: vi.fn(),
  listPublishingDestinations: vi.fn(),
  getPublishingDestination: vi.fn(),
  requestPostPublish: vi.fn(),
  approvePublishRequest: vi.fn(),
  rejectPublishRequest: vi.fn(),
  cancelPublishRequest: vi.fn(),
}));
vi.mock("@/lib/workspaces/queries", () => ({ getMyWorkspace: mocks.getMyWorkspace }));
vi.mock("@/lib/publishing/destinations", () => ({
  listPublishingDestinations: mocks.listPublishingDestinations,
  getPublishingDestination: mocks.getPublishingDestination,
}));
vi.mock("@/lib/content/publish-requests", () => ({
  requestPostPublish: mocks.requestPostPublish,
  approvePublishRequest: mocks.approvePublishRequest,
  rejectPublishRequest: mocks.rejectPublishRequest,
  cancelPublishRequest: mocks.cancelPublishRequest,
}));

import { ContentError } from "@/lib/content/errors";

import { type AgentToolContext, createAgentToolContext, executeAgentTool } from "./executor";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "u@example.test" };
const WS = "22222222-2222-4222-8222-222222222222";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const POST = "44444444-4444-4444-8444-444444444444";
const DEST = "88888888-8888-4888-8888-888888888888";
const REQUEST = "66666666-6666-4666-8666-666666666666";
const TURN = "77777777-7777-4777-8777-777777777777";

const destination = {
  id: DEST,
  workspaceId: WS,
  kind: "internal",
  name: "Nội bộ",
  targetRef: "secret-target-ref",
  status: "active",
  createdAt: "2026-11-01T00:00:00Z",
};
const pendingRequest = {
  id: REQUEST,
  workspaceId: WS,
  postId: POST,
  destinationId: DEST,
  postVersion: 3,
  status: "pending",
  displayStatus: "pending",
  requestSource: "agent",
  agentTurnId: TURN,
  reason: null,
  requestedBy: USER.id,
  requestedAt: "2026-11-21T10:00:00Z",
  expiresAt: "2026-11-28T10:00:00Z",
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  cancelReason: null,
};

let ctx: AgentToolContext;
const turn = { turnId: TURN };
const args = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ post_id: POST, expected_version: 3, destination_id: DEST, reason: null, ...extra });

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getMyWorkspace.mockResolvedValue({ id: WS, name: "WS", role: "owner", createdAt: "2026-11-01T00:00:00Z" });
  ctx = await createAgentToolContext(USER, WS);
  mocks.getPublishingDestination.mockResolvedValue(destination);
  mocks.requestPostPublish.mockResolvedValue(pendingRequest);
});

describe("list_publish_destinations", () => {
  it("reads only the context workspace and returns id, name, kind and status only", async () => {
    mocks.listPublishingDestinations.mockResolvedValue([destination]);
    const result = await executeAgentTool(ctx, "list_publish_destinations", "{}");
    expect(mocks.listPublishingDestinations).toHaveBeenCalledWith({ workspaceId: WS });
    expect(result).toMatchObject({ ok: true, effect: { kind: "read" } });
    expect((result as { data: unknown }).data).toEqual({
      destinations: [{ id: DEST, name: "Nội bộ", kind: "internal", status: "active" }],
    });
    // Nothing sensitive or internal reaches the model.
    expect(JSON.stringify(result)).not.toMatch(/secret-target-ref|target|credential|token|webhook|workspace/i);
  });

  it("accepts no argument (cannot be pointed at another workspace)", async () => {
    const result = await executeAgentTool(ctx, "list_publish_destinations", JSON.stringify({ workspace_id: OTHER_WS }));
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.listPublishingDestinations).not.toHaveBeenCalled();
  });
});

describe("request_publish", () => {
  it("creates a pending request through the data layer, as the agent, with the server's turn id", async () => {
    const result = await executeAgentTool(ctx, "request_publish", args({ reason: "  Sẵn sàng  " }), turn);
    expect(mocks.requestPostPublish).toHaveBeenCalledWith(
      { postId: POST, expectedVersion: 3, destinationId: DEST, reason: "Sẵn sàng" },
      { source: "agent", agentTurnId: TURN, workspaceId: WS },
    );
    expect(result).toMatchObject({
      ok: true,
      effect: { kind: "publish_request", postId: POST, versionAfter: 3, requestId: REQUEST, destinationId: DEST },
    });
    const data = (result as { data: { publish_request: Record<string, unknown> } }).data.publish_request;
    expect(data).toMatchObject({ status: "pending", post_id: POST, post_version: 3, destination: { id: DEST, name: "Nội bộ" } });
    expect(String(data.note)).toMatch(/Nothing has been published/);
    // The model never gets the request id, user ids or the target reference.
    const forModel = JSON.stringify((result as { data: unknown }).data);
    expect(forModel).not.toContain(REQUEST);
    expect(forModel).not.toContain(USER.id);
    expect(forModel).not.toContain("secret-target-ref");
  });

  it("never approves, rejects, cancels or publishes", async () => {
    await executeAgentTool(ctx, "request_publish", args(), turn);
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
    expect(mocks.rejectPublishRequest).not.toHaveBeenCalled();
    expect(mocks.cancelPublishRequest).not.toHaveBeenCalled();
  });

  it("requires a destination: no default", async () => {
    const result = await executeAgentTool(
      ctx,
      "request_publish",
      JSON.stringify({ post_id: POST, expected_version: 3, reason: null }),
      turn,
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.requestPostPublish).not.toHaveBeenCalled();
  });

  it.each(["user_id", "role", "source", "turn_id", "agent_turn_id", "workspace_id", "status", "requested_by", "approve"])(
    "rejects the forged argument %s",
    async (key) => {
      const result = await executeAgentTool(ctx, "request_publish", args({ [key]: "x" }), turn);
      expect(result).toMatchObject({ ok: false, code: "invalid_input" });
      expect(mocks.requestPostPublish).not.toHaveBeenCalled();
    },
  );

  it("without a server-provided turn it refuses (the model cannot supply one)", async () => {
    const result = await executeAgentTool(ctx, "request_publish", args());
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.requestPostPublish).not.toHaveBeenCalled();
  });

  it("a destination of another workspace is not_found, nothing requested", async () => {
    mocks.getPublishingDestination.mockResolvedValue({ ...destination, workspaceId: OTHER_WS });
    expect(await executeAgentTool(ctx, "request_publish", args(), turn)).toMatchObject({ ok: false, code: "not_found" });
    mocks.getPublishingDestination.mockResolvedValue(null);
    expect(await executeAgentTool(ctx, "request_publish", args(), turn)).toMatchObject({ ok: false, code: "not_found" });
    expect(mocks.requestPostPublish).not.toHaveBeenCalled();
  });

  it("a disabled destination is refused", async () => {
    mocks.getPublishingDestination.mockResolvedValue({ ...destination, status: "disabled" });
    expect(await executeAgentTool(ctx, "request_publish", args(), turn)).toMatchObject({
      ok: false,
      code: "destination_disabled",
    });
    expect(mocks.requestPostPublish).not.toHaveBeenCalled();
  });

  it.each([
    ["version_conflict", "a stale version"],
    ["request_pending_exists", "an existing pending request"],
    ["post_published", "an already published post"],
    ["not_found", "a post of another workspace"],
    ["archived", "an archived post"],
    ["forbidden", "a database refusal"],
  ] as const)("reports %s (%s) without retrying", async (code, label) => {
    mocks.requestPostPublish.mockRejectedValue(new ContentError(code));
    const result = await executeAgentTool(ctx, "request_publish", args(), turn);
    expect(result, label).toMatchObject({ ok: false, code, effect: { kind: "publish_request", postId: POST } });
    expect(mocks.requestPostPublish).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ post_id: "nope" }],
    [{ expected_version: 0 }],
    [{ destination_id: "nope" }],
    [{ reason: "x".repeat(501) }],
  ])("rejects invalid input %j", async (extra) => {
    expect(await executeAgentTool(ctx, "request_publish", args(extra), turn)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.requestPostPublish).not.toHaveBeenCalled();
  });
});

describe("no approval path for the agent", () => {
  it.each(["approve_publish_request", "reject_publish_request", "cancel_publish_request", "publish_post", "approve"])(
    "%s is not a tool",
    async (name) => {
      expect(await executeAgentTool(ctx, name, "{}", turn)).toMatchObject({ ok: false, code: "unknown_tool" });
      expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
    },
  );
});
