import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dbError, fakeSupabase, ok, type FakeResult } from "./__tests__/fake-supabase";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), getCurrentUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth/dal", () => ({ getCurrentUser: mocks.getCurrentUser }));

import { CONTENT_ERROR_MESSAGES, ContentError } from "./errors";
import * as publish from "./publish-requests";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "55555555-5555-4555-8555-555555555555";
const WS = "22222222-2222-4222-8222-222222222222";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";
const REQUEST = "66666666-6666-4666-8666-666666666666";
const TURN = "77777777-7777-4777-8777-777777777777";
const DEST = "88888888-8888-4888-8888-888888888888"; // internal destination of WS
const EXT = "99999999-0000-4000-8000-000000000001"; // another destination of WS

const NOW = new Date("2026-11-20T12:00:00Z");

const requestRow = {
  id: REQUEST,
  workspace_id: WS,
  post_id: POST,
  destination_id: DEST,
  post_version: 3,
  status: "pending",
  request_source: "user",
  agent_turn_id: null,
  reason: "Sẵn sàng",
  requested_by: OTHER,
  requested_at: "2026-11-19T12:00:00Z",
  expires_at: "2026-11-26T12:00:00Z",
  decided_by: null,
  decided_at: null,
  decision_note: null,
  cancel_reason: null,
};

const publishedRow = {
  id: POST,
  workspace_id: WS,
  project_id: PROJECT,
  title: "Hello",
  body: "Body",
  status: "published",
  scheduled_for: null,
  published_at: "2026-11-20T12:00:00Z",
  version: 4,
  last_change_source: "user",
  created_by: OTHER,
  updated_by: USER,
  archived_at: null,
  created_at: "2026-11-18T10:00:00Z",
  updated_at: "2026-11-20T12:00:00Z",
};

const role = (r: "owner" | "admin" | "member") => ok({ role: r });
const destinationRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: WS,
  kind: "internal",
  name: "Nội bộ",
  target_ref: null,
  status: "active",
  created_at: "2026-11-01T00:00:00Z",
  ...over,
});
/** Reads done by requestPostPublish before the RPC: the post, then the destination. */
const postRef = (workspaceId = WS) => ok({ id: POST, workspace_id: workspaceId });
const internalDest = () => ok(destinationRow(DEST));

function setup(results: FakeResult[]) {
  const fake = fakeSupabase(results);
  mocks.createClient.mockResolvedValue(fake.client);
  return fake;
}

async function expectContentError(promise: Promise<unknown>, code: ContentError["code"]) {
  const error = await promise.then(
    () => {
      throw new Error("expected a ContentError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ContentError);
  expect((error as ContentError).code).toBe(code);
  return error as ContentError;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.getCurrentUser.mockResolvedValue({ id: USER, email: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("module surface", () => {
  it("exposes only the approval operations (no direct publish, no delete)", () => {
    expect(Object.keys(publish).sort()).toEqual(
      [
        "approvePublishRequest",
        "cancelPublishRequest",
        "countPublishRequests",
        "getPublishRequest",
        "listPublishRequests",
        "listPublishRequestsPage",
        "rejectPublishRequest",
        "requestPostPublish",
      ].sort(),
    );
  });
});

describe("RPC signatures match the LATEST migration defining them", () => {
  // Migrations replace functions (M4.6a); the last definition in file order wins.
  const dir = join(process.cwd(), "supabase/migrations");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  const params = (fn: string) => {
    const matches = [...sql.matchAll(new RegExp(`create function public\\.${fn}\\(([^)]*)\\)`, "g"))];
    const last = matches.at(-1);
    if (!last) throw new Error(`function ${fn} not found in migrations`);
    return last[1]!.split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
  };

  it.each([
    ["request_post_publish", ["p_post_id", "p_expected_version", "p_source", "p_agent_turn_id", "p_reason", "p_destination_id"]],
    ["approve_publish_request", ["p_request_id", "p_expected_post_version", "p_expected_destination_id"]],
    ["reject_publish_request", ["p_request_id", "p_note"]],
    ["cancel_publish_request", ["p_request_id"]],
  ])("%s(%s)", async (fn, expected) => {
    expect(params(fn)).toEqual(expected);

    const run = {
      request_post_publish: () => publish.requestPostPublish({ postId: POST, expectedVersion: 3 }),
      approve_publish_request: () => publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }),
      reject_publish_request: () => publish.rejectPublishRequest({ requestId: REQUEST }),
      cancel_publish_request: () => publish.cancelPublishRequest({ requestId: REQUEST }),
    }[fn as string]!;
    const result = fn === "approve_publish_request" ? publishedRow : requestRow;
    const fake = setup(
      fn === "request_post_publish"
        ? [postRef(), internalDest(), ok(result)]
        : [ok({ ...requestRow, requested_by: USER }), role("owner"), ok(result)],
    );
    await run();
    expect(fake.rpcs).toHaveLength(1);
    expect(fake.rpcs[0]!.fn).toBe(fn);
    expect(Object.keys(fake.rpcs[0]!.args)).toEqual(expected);
  });
});

describe("unauthenticated callers", () => {
  it.each([
    ["request", () => publish.requestPostPublish({ postId: POST, expectedVersion: 3 })],
    ["approve", () => publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 })],
    ["reject", () => publish.rejectPublishRequest({ requestId: REQUEST })],
    ["cancel", () => publish.cancelPublishRequest({ requestId: REQUEST })],
    ["list", () => publish.listPublishRequests({ workspaceId: WS })],
    ["get", () => publish.getPublishRequest({ requestId: REQUEST })],
  ])("%s: rejected before any database call", async (_name, run) => {
    mocks.getCurrentUser.mockResolvedValue(null);
    await expectContentError(run(), "unauthenticated");
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

describe("requestPostPublish", () => {
  it("legacy call without a destination: resolves the internal destination and passes it explicitly", async () => {
    const fake = setup([postRef(), internalDest(), ok(requestRow)]);
    const result = await publish.requestPostPublish({ postId: POST.toUpperCase(), expectedVersion: "3", reason: "  Sẵn sàng " });

    expect(fake.queries[0]!.table).toBe("content_posts");
    expect(fake.queries[1]!.table).toBe("publishing_destinations");
    expect(fake.queries[1]!.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(fake.queries[1]!.calls).toContainEqual(["eq", ["kind", "internal"]]);
    expect(fake.rpcs).toEqual([
      {
        fn: "request_post_publish",
        args: {
          p_post_id: POST,
          p_expected_version: 3,
          p_source: "user",
          p_agent_turn_id: null,
          p_reason: "Sẵn sàng",
          p_destination_id: DEST,
        },
      },
    ]);
    expect(result).toMatchObject({ id: REQUEST, destinationId: DEST, postVersion: 3, status: "pending", displayStatus: "pending" });
  });

  it("an explicit destination of the post's workspace is checked and passed", async () => {
    const fake = setup([postRef(), ok(destinationRow(EXT, { name: "Kênh A" })), ok({ ...requestRow, destination_id: EXT })]);
    const result = await publish.requestPostPublish({ postId: POST, expectedVersion: 3, destinationId: EXT });
    expect(fake.queries[1]!.calls).toContainEqual(["eq", ["id", EXT]]);
    expect(fake.rpcs[0]!.args.p_destination_id).toBe(EXT);
    expect(result.destinationId).toBe(EXT);
  });

  it("a destination of another workspace (or invisible) is not_found, nothing written", async () => {
    let fake = setup([postRef(), ok(destinationRow(EXT, { workspace_id: OTHER_WS }))]);
    await expectContentError(publish.requestPostPublish({ postId: POST, expectedVersion: 3, destinationId: EXT }), "not_found");
    expect(fake.rpcs).toHaveLength(0);
    fake = setup([postRef(), ok(null)]);
    await expectContentError(publish.requestPostPublish({ postId: POST, expectedVersion: 3, destinationId: EXT }), "not_found");
    expect(fake.rpcs).toHaveLength(0);
  });

  it("a disabled destination: destination_disabled (Vietnamese), nothing written", async () => {
    const fake = setup([postRef(), ok(destinationRow(EXT, { status: "disabled" }))]);
    const error = await expectContentError(
      publish.requestPostPublish({ postId: POST, expectedVersion: 3, destinationId: EXT }),
      "destination_disabled",
    );
    expect(error.message).toMatch(/tạm ngừng/);
    expect(fake.rpcs).toHaveLength(0);
  });

  it("a post that is not visible: not_found before resolving any destination", async () => {
    const fake = setup([ok(null)]);
    await expectContentError(publish.requestPostPublish({ postId: POST, expectedVersion: 3 }), "not_found");
    expect(fake.queries).toHaveLength(1);
    expect(fake.rpcs).toHaveLength(0);
  });

  it("sends an empty reason as null", async () => {
    const fake = setup([postRef(), internalDest(), ok(requestRow)]);
    await publish.requestPostPublish({ postId: POST, expectedVersion: 3, reason: "   " });
    expect(fake.rpcs[0]!.args.p_reason).toBeNull();
  });

  it.each([
    "requestedBy",
    "requested_by",
    "decidedBy",
    "decided_by",
    "userId",
    "user_id",
    "role",
    "status",
    "source",
    "agentTurnId",
    "workspaceId",
    "expiresAt",
  ])("rejects the client-controlled field %s", async (key) => {
    const fake = setup([]);
    const error = await expectContentError(
      publish.requestPostPublish({ postId: POST, expectedVersion: 3, [key]: "x" }),
      "invalid_input",
    );
    expect(error.fieldErrors?.[key]).toBe("Không được phép gửi trường này.");
    expect(fake.rpcs).toHaveLength(0);
  });

  it.each([
    [{ postId: "nope", expectedVersion: 3 }],
    [{ postId: POST, expectedVersion: 0 }],
    [{ postId: POST, expectedVersion: "1.5" }],
    [{ postId: POST }],
    [{ postId: POST, expectedVersion: 3, reason: "x".repeat(501) }],
    [{ postId: POST, expectedVersion: 3, reason: "a\u0000b" }],
  ])("rejects invalid input %j", async (input) => {
    const fake = setup([]);
    await expectContentError(publish.requestPostPublish(input), "invalid_input");
    expect(fake.rpcs).toHaveLength(0);
  });

  it("accepts a reason of exactly 500 code points (emoji count once)", async () => {
    const fake = setup([postRef(), internalDest(), ok(requestRow)]);
    await publish.requestPostPublish({ postId: POST, expectedVersion: 3, reason: "😀".repeat(500) });
    expect(fake.rpcs).toHaveLength(1);
  });

  it("agent requests (trusted option) pass the source, turn id and their explicit destination", async () => {
    const fake = setup([postRef(), internalDest(), ok({ ...requestRow, request_source: "agent", agent_turn_id: TURN })]);
    const result = await publish.requestPostPublish(
      { postId: POST, expectedVersion: 3, destinationId: DEST },
      { source: "agent", agentTurnId: TURN, workspaceId: WS },
    );
    expect(fake.queries[0]!.table).toBe("content_posts");
    expect(fake.rpcs[0]!.args).toMatchObject({ p_source: "agent", p_agent_turn_id: TURN, p_destination_id: DEST });
    expect(result).toMatchObject({ requestSource: "agent", agentTurnId: TURN });
  });

  it("agent requests without a destination are rejected before any query", async () => {
    const fake = setup([]);
    const error = await expectContentError(
      publish.requestPostPublish({ postId: POST, expectedVersion: 3 }, { source: "agent", agentTurnId: TURN, workspaceId: WS }),
      "invalid_input",
    );
    expect(error.fieldErrors?.destinationId).toBe("Cần chọn đích xuất bản.");
    expect(fake.queries).toHaveLength(0);
  });

  it("a workspace-scoped call refuses a post of another workspace without writing", async () => {
    const fake = setup([postRef(OTHER_WS)]);
    await expectContentError(
      publish.requestPostPublish({ postId: POST, expectedVersion: 3, destinationId: DEST }, { source: "agent", agentTurnId: TURN, workspaceId: WS }),
      "not_found",
    );
    expect(fake.rpcs).toHaveLength(0);
  });

  it.each([
    [{ source: "agent" }],
    [{ source: "user", agentTurnId: TURN }],
    [{ source: "admin" }],
    [{ agentTurnId: "nope", source: "agent" }],
    [{ requestedBy: USER }],
  ])("rejects inconsistent internal options %j", async (options) => {
    const fake = setup([]);
    await expectContentError(
      publish.requestPostPublish({ postId: POST, expectedVersion: 3 }, options as publish.PublishRequestOptions),
      "invalid_input",
    );
    expect(fake.rpcs).toHaveLength(0);
  });

  it.each([
    ["CP409", "version_conflict"],
    ["CP412", "request_pending_exists"],
    ["23505", "request_pending_exists"],
    ["CP422", "post_published"],
    ["CP423", "archived"],
    ["CP404", "not_found"],
    ["CP426", "destination_disabled"],
    ["42501", "forbidden"],
  ] as const)("maps database error %s to %s", async (sqlstate, code) => {
    setup([postRef(), internalDest(), dbError(sqlstate)]);
    const error = await expectContentError(publish.requestPostPublish({ postId: POST, expectedVersion: 3 }), code);
    expect(error.message).toBe(CONTENT_ERROR_MESSAGES[code]);
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/secret/);
  });
});

describe("approvePublishRequest", () => {
  it("owner: checks the request and own role, then approves with the shown version", async () => {
    const fake = setup([ok(requestRow), role("owner"), ok(publishedRow)]);
    const result = await publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 });

    expect(fake.queries[0]!.table).toBe("content_publish_requests");
    expect(fake.queries[0]!.calls).toContainEqual(["eq", ["id", REQUEST]]);
    // The role comes from workspace_members, for the session user, in the request's workspace.
    expect(fake.queries[1]!.table).toBe("workspace_members");
    expect(fake.queries[1]!.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(fake.queries[1]!.calls).toContainEqual(["eq", ["user_id", USER]]);
    // Legacy call without expectedDestinationId: the stored destination is sent explicitly.
    expect(fake.rpcs).toEqual([
      {
        fn: "approve_publish_request",
        args: { p_request_id: REQUEST, p_expected_post_version: 3, p_expected_destination_id: DEST },
      },
    ]);
    expect(result).toEqual({
      id: POST,
      workspaceId: WS,
      projectId: PROJECT,
      title: "Hello",
      status: "published",
      version: 4,
      publishedAt: "2026-11-20T12:00:00Z",
      updatedBy: USER,
    });
  });

  it("passes the destination the approver was shown", async () => {
    const fake = setup([ok(requestRow), role("owner"), ok(publishedRow)]);
    await publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3, expectedDestinationId: DEST.toUpperCase() });
    expect(fake.rpcs[0]!.args.p_expected_destination_id).toBe(DEST);
  });

  it("a different destination than requested: destination_mismatch, no RPC call", async () => {
    const fake = setup([ok(requestRow), role("owner")]);
    const error = await expectContentError(
      publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3, expectedDestinationId: EXT }),
      "destination_mismatch",
    );
    expect(error.message).toMatch(/không khớp/);
    expect(fake.rpcs).toHaveLength(0);
  });

  it("CP426 from the database (destination disabled meanwhile) -> destination_disabled", async () => {
    setup([ok(requestRow), role("owner"), dbError("CP426")]);
    await expectContentError(publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }), "destination_disabled");
  });

  it("admin may approve too, including a request they sent themselves", async () => {
    const fake = setup([ok({ ...requestRow, requested_by: USER }), role("admin"), ok(publishedRow)]);
    await publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 });
    expect(fake.rpcs).toHaveLength(1);
  });

  it("member: forbidden, no RPC call (even for their own request)", async () => {
    const fake = setup([ok({ ...requestRow, requested_by: USER }), role("member")]);
    await expectContentError(publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }), "forbidden");
    expect(fake.rpcs).toHaveLength(0);
  });

  it("request not visible (other workspace): not_found, no RPC call", async () => {
    const fake = setup([ok(null)]);
    await expectContentError(publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }), "not_found");
    expect(fake.rpcs).toHaveLength(0);
  });

  it("no membership row for the request's workspace: not_found", async () => {
    const fake = setup([ok(requestRow), ok(null)]);
    await expectContentError(publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }), "not_found");
    expect(fake.rpcs).toHaveLength(0);
  });

  it("expired request: request_expired, no RPC call", async () => {
    const fake = setup([ok({ ...requestRow, expires_at: "2026-11-20T11:59:59Z" }), role("owner")]);
    const error = await expectContentError(
      publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }),
      "request_expired",
    );
    expect(error.message).toMatch(/hết hạn sau 7 ngày/);
    expect(fake.rpcs).toHaveLength(0);
  });

  it("expiry exactly now counts as expired (same rule as the database)", async () => {
    setup([ok({ ...requestRow, expires_at: NOW.toISOString() }), role("owner")]);
    await expectContentError(publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }), "request_expired");
  });

  it.each(["approved", "rejected", "cancelled"])("repeat on a %s request: request_closed, no RPC call", async (status) => {
    const fake = setup([ok({ ...requestRow, status, decided_by: USER, decided_at: "2026-11-20T11:00:00Z" }), role("owner")]);
    const error = await expectContentError(
      publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }),
      "request_closed",
    );
    expect(error.message).toMatch(/đã được xử lý/);
    expect(fake.rpcs).toHaveLength(0);
  });

  it("shown version differs from the requested version: version_conflict, no RPC call", async () => {
    const fake = setup([ok(requestRow), role("owner")]);
    await expectContentError(publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 4 }), "version_conflict");
    expect(fake.rpcs).toHaveLength(0);
  });

  it.each([
    ["CP410", "request_closed"], // decided concurrently, or the post changed and cancelled it
    ["CP409", "version_conflict"], // post changed under the lock
    ["CP422", "post_published"],
    ["CP423", "archived"],
    ["42501", "forbidden"], // role lost meanwhile, or agent marker header
    ["CP404", "not_found"],
  ] as const)("database is the authority: %s -> %s", async (sqlstate, code) => {
    setup([ok(requestRow), role("owner"), dbError(sqlstate)]);
    await expectContentError(publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }), code);
  });

  it("a second approval after success is refused by the pre-check", async () => {
    setup([ok(requestRow), role("owner"), ok(publishedRow)]);
    await publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 });

    const fake = setup([ok({ ...requestRow, status: "approved", decided_by: USER, decided_at: NOW.toISOString() }), role("owner")]);
    await expectContentError(publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }), "request_closed");
    expect(fake.rpcs).toHaveLength(0);
  });

  it.each(["decidedBy", "decided_by", "userId", "role", "approverId", "workspaceId", "expectedVersion"])(
    "rejects the client-controlled field %s",
    async (key) => {
      const fake = setup([]);
      await expectContentError(
        publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3, [key]: USER }),
        "invalid_input",
      );
      expect(fake.queries).toHaveLength(0);
      expect(fake.rpcs).toHaveLength(0);
    },
  );

  it("a non-published result is treated as an unexpected error", async () => {
    setup([ok(requestRow), role("owner"), ok({ ...publishedRow, status: "draft", published_at: null })]);
    await expectContentError(publish.approvePublishRequest({ requestId: REQUEST, expectedPostVersion: 3 }), "unknown");
  });
});

describe("rejectPublishRequest", () => {
  it("admin rejects with a trimmed note", async () => {
    const fake = setup([
      ok(requestRow),
      role("admin"),
      ok({ ...requestRow, status: "rejected", decided_by: USER, decided_at: NOW.toISOString(), decision_note: "Sửa tiêu đề" }),
    ]);
    const result = await publish.rejectPublishRequest({ requestId: REQUEST, note: "  Sửa tiêu đề " });
    expect(fake.rpcs).toEqual([{ fn: "reject_publish_request", args: { p_request_id: REQUEST, p_note: "Sửa tiêu đề" } }]);
    expect(result).toMatchObject({ status: "rejected", displayStatus: "rejected", decidedBy: USER, decisionNote: "Sửa tiêu đề" });
  });

  it("member: forbidden", async () => {
    const fake = setup([ok(requestRow), role("member")]);
    await expectContentError(publish.rejectPublishRequest({ requestId: REQUEST }), "forbidden");
    expect(fake.rpcs).toHaveLength(0);
  });

  it("expired: request_expired; already decided: request_closed", async () => {
    setup([ok({ ...requestRow, expires_at: "2026-11-01T00:00:00Z" }), role("owner")]);
    await expectContentError(publish.rejectPublishRequest({ requestId: REQUEST }), "request_expired");
    setup([ok({ ...requestRow, status: "rejected", decided_at: "2026-11-20T11:00:00Z" }), role("owner")]);
    await expectContentError(publish.rejectPublishRequest({ requestId: REQUEST }), "request_closed");
  });

  it("note over 500 characters is rejected before any call", async () => {
    const fake = setup([]);
    await expectContentError(publish.rejectPublishRequest({ requestId: REQUEST, note: "x".repeat(501) }), "invalid_input");
    expect(fake.queries).toHaveLength(0);
  });

  it("CP410 from the database (decided concurrently) -> request_closed", async () => {
    setup([ok(requestRow), role("owner"), dbError("CP410")]);
    await expectContentError(publish.rejectPublishRequest({ requestId: REQUEST }), "request_closed");
  });
});

describe("cancelPublishRequest", () => {
  it("the requester (a member) withdraws their own request", async () => {
    const fake = setup([
      ok({ ...requestRow, requested_by: USER }),
      role("member"),
      ok({ ...requestRow, status: "cancelled", cancel_reason: "withdrawn", decided_by: USER, decided_at: NOW.toISOString() }),
    ]);
    const result = await publish.cancelPublishRequest({ requestId: REQUEST });
    expect(fake.rpcs).toEqual([{ fn: "cancel_publish_request", args: { p_request_id: REQUEST } }]);
    expect(result).toMatchObject({ status: "cancelled", cancelReason: "withdrawn" });
  });

  it("an owner may cancel someone else's request", async () => {
    const fake = setup([ok(requestRow), role("owner"), ok({ ...requestRow, status: "cancelled", cancel_reason: "withdrawn", decided_at: NOW.toISOString() })]);
    await publish.cancelPublishRequest({ requestId: REQUEST });
    expect(fake.rpcs).toHaveLength(1);
  });

  it("another member cannot cancel someone else's request", async () => {
    const fake = setup([ok(requestRow), role("member")]);
    await expectContentError(publish.cancelPublishRequest({ requestId: REQUEST }), "forbidden");
    expect(fake.rpcs).toHaveLength(0);
  });

  it("an expired pending request can still be closed", async () => {
    const fake = setup([
      ok({ ...requestRow, requested_by: USER, expires_at: "2026-11-01T00:00:00Z" }),
      role("member"),
      ok({ ...requestRow, status: "cancelled", cancel_reason: "expired", decided_at: NOW.toISOString() }),
    ]);
    const result = await publish.cancelPublishRequest({ requestId: REQUEST });
    expect(fake.rpcs).toHaveLength(1);
    expect(result.cancelReason).toBe("expired");
  });

  it("cancelling twice: request_closed, no RPC call", async () => {
    const fake = setup([ok({ ...requestRow, requested_by: USER, status: "cancelled", cancel_reason: "withdrawn" }), role("member")]);
    await expectContentError(publish.cancelPublishRequest({ requestId: REQUEST }), "request_closed");
    expect(fake.rpcs).toHaveLength(0);
  });
});

describe("listPublishRequests", () => {
  it("reads one workspace, newest first, and marks expired pending requests", async () => {
    const fake = setup([
      ok([
        requestRow,
        { ...requestRow, id: OTHER, expires_at: "2026-11-10T00:00:00Z" },
        { ...requestRow, id: TURN, status: "approved", decided_by: USER, decided_at: "2026-11-20T10:00:00Z" },
      ]),
    ]);
    const result = await publish.listPublishRequests({ workspaceId: WS, status: "pending", postId: POST, limit: 20 });
    const query = fake.queries[0]!;
    expect(query.table).toBe("content_publish_requests");
    expect(query.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(query.calls).toContainEqual(["eq", ["post_id", POST]]);
    expect(query.calls).toContainEqual(["eq", ["status", "pending"]]);
    expect(query.calls).toContainEqual(["order", ["requested_at", { ascending: false }]]);
    expect(query.calls).toContainEqual(["limit", [20]]);
    expect(result.map((r) => r.displayStatus)).toEqual(["pending", "expired", "approved"]);
  });

  it.each([{ workspaceId: "nope" }, { workspaceId: WS, status: "published" }, { workspaceId: WS, limit: 1000 }, { workspaceId: WS, userId: USER }])(
    "rejects invalid input %j",
    async (input) => {
      const fake = setup([]);
      await expectContentError(publish.listPublishRequests(input), "invalid_input");
      expect(fake.queries).toHaveLength(0);
    },
  );
});

describe("getPublishRequest", () => {
  it("returns the request with its audit trail in lifecycle order", async () => {
    const events = [
      { id: "e1", request_id: REQUEST, post_id: POST, post_version: 3, event: "requested", cancel_reason: null, actor_id: OTHER, actor_source: "agent", created_at: "2026-11-19T12:00:00Z" },
      { id: "e2", request_id: REQUEST, post_id: POST, post_version: 3, event: "approved", cancel_reason: null, actor_id: USER, actor_source: "user", created_at: NOW.toISOString() },
      { id: "e3", request_id: REQUEST, post_id: POST, post_version: 4, event: "published", cancel_reason: null, actor_id: USER, actor_source: "user", created_at: NOW.toISOString() },
    ];
    const fake = setup([ok({ ...requestRow, status: "approved" }), ok(events)]);
    const detail = await publish.getPublishRequest({ requestId: REQUEST });

    expect(fake.queries[1]!.table).toBe("content_publish_request_events");
    expect(fake.queries[1]!.calls).toContainEqual(["eq", ["request_id", REQUEST]]);
    expect(fake.queries[1]!.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(fake.queries[1]!.calls).toContainEqual(["order", ["created_at", { ascending: true }]]);
    expect(fake.queries[1]!.calls).toContainEqual(["order", ["event", { ascending: true }]]);
    expect(detail?.request.status).toBe("approved");
    expect(detail?.events.map((e) => `${e.event}:${e.actorSource}`)).toEqual(["requested:agent", "approved:user", "published:user"]);
  });

  it("returns null for a request that is not visible, without reading events", async () => {
    const fake = setup([ok(null)]);
    expect(await publish.getPublishRequest({ requestId: REQUEST })).toBeNull();
    expect(fake.queries).toHaveLength(1);
  });

  it("hides database error details", async () => {
    setup([dbError("XX000")]);
    const error = await expectContentError(publish.getPublishRequest({ requestId: REQUEST }), "unknown");
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/secret|relation/);
  });
});

describe("listPublishRequestsPage (server-side pagination)", () => {
  it("filters, orders stably and reads exactly one page with an exact total", async () => {
    const fake = setup([{ data: [requestRow], error: null, count: 45 }]);
    const page = await publish.listPublishRequestsPage({ workspaceId: WS, filter: "approved", page: 3, pageSize: 20 });
    const query = fake.queries[0]!;
    expect(query.table).toBe("content_publish_requests");
    expect(query.calls).toContainEqual(["select", [expect.any(String), { count: "exact" }]]);
    expect(query.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(query.calls).toContainEqual(["eq", ["status", "approved"]]);
    // Stable order: newest first, id as tie-breaker.
    const orders = query.calls.filter(([m]) => m === "order");
    expect(orders).toEqual([
      ["order", ["requested_at", { ascending: false }]],
      ["order", ["id", { ascending: false }]],
    ]);
    expect(query.calls).toContainEqual(["range", [40, 59]]);
    expect(page).toMatchObject({ filter: "approved", page: 3, pageSize: 20, total: 45, totalPages: 3 });
    expect(page.items).toHaveLength(1);
  });

  it.each([
    ["pending", [["eq", ["status", "pending"]], ["gt", ["expires_at", NOW.toISOString()]]]],
    ["expired", [["eq", ["status", "pending"]], ["lte", ["expires_at", NOW.toISOString()]]]],
  ] as const)("%s is decided by expires_at in the database query", async (filter, expected) => {
    const fake = setup([{ data: [], error: null, count: 0 }]);
    const page = await publish.listPublishRequestsPage({ workspaceId: WS, filter });
    for (const call of expected) expect(fake.queries[0]!.calls).toContainEqual(call);
    expect(fake.queries[0]!.calls).toContainEqual(["range", [0, 19]]);
    expect(page).toMatchObject({ total: 0, totalPages: 1, items: [] });
  });

  it("'all' applies no status filter", async () => {
    const fake = setup([{ data: [], error: null, count: 0 }]);
    await publish.listPublishRequestsPage({ workspaceId: WS, filter: "all" });
    expect(fake.queries[0]!.methods()).not.toContain("gt");
    expect(fake.queries[0]!.calls.filter(([m, args]) => m === "eq" && args[0] === "status")).toHaveLength(0);
  });

  it.each([
    { workspaceId: "nope" },
    { workspaceId: WS, filter: "published" },
    { workspaceId: WS, page: 0 },
    { workspaceId: WS, page: 1.5 },
    { workspaceId: WS, pageSize: 101 },
    { workspaceId: WS, userId: USER },
  ])("rejects invalid input %j", async (input) => {
    const fake = setup([]);
    await expectContentError(publish.listPublishRequestsPage(input), "invalid_input");
    expect(fake.queries).toHaveLength(0);
  });

  it("hides database errors", async () => {
    setup([dbError("XX000")]);
    await expectContentError(publish.listPublishRequestsPage({ workspaceId: WS }), "unknown");
  });

  it("a page past the end (PostgREST 416 / PGRST103) is an empty page with the exact total", async () => {
    const fake = setup([dbError("PGRST103"), { data: null, error: null, count: 30 }]);
    const page = await publish.listPublishRequestsPage({ workspaceId: WS, filter: "pending", page: 9, pageSize: 20 });
    expect(page).toMatchObject({ items: [], total: 30, totalPages: 2, page: 9 });
    const recount = fake.queries[1]!;
    expect(recount.calls).toContainEqual(["select", ["id", { count: "exact", head: true }]]);
    expect(recount.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(recount.calls).toContainEqual(["eq", ["status", "pending"]]);
  });
});

describe("countPublishRequests", () => {
  it("counts each display status with head-only queries in one workspace", async () => {
    const fake = setup([
      { data: null, error: null, count: 3 },
      { data: null, error: null, count: 1 },
      { data: null, error: null, count: 120 },
      { data: null, error: null, count: 2 },
      { data: null, error: null, count: 4 },
    ] as FakeResult[]);
    const counts = await publish.countPublishRequests({ workspaceId: WS });
    expect(counts).toEqual({ pending: 3, expired: 1, approved: 120, rejected: 2, cancelled: 4, all: 130 });
    expect(fake.queries).toHaveLength(5);
    for (const query of fake.queries) {
      expect(query.calls).toContainEqual(["select", ["id", { count: "exact", head: true }]]);
      expect(query.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    }
  });
});
