import { beforeEach, describe, expect, it, vi } from "vitest";

import { dbError, fakeSupabase, ok, type FakeResult } from "@/lib/content/__tests__/fake-supabase";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ contentClient: vi.fn() }));
vi.mock("@/lib/content/client", () => ({ contentClient: mocks.contentClient }));

import { ContentError } from "@/lib/content/errors";

import { type LoggableAgentAction, listAgentActions, recordAgentAction, toAgentActionRow } from "./actions-log";
import type { AgentToolContext } from "./executor";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";
const TURN = "77777777-7777-4777-8777-777777777777";

const ctx = Object.freeze({ workspaceId: WS, userId: USER, role: "member" }) as AgentToolContext;

function setup(results: FakeResult[], userId = USER) {
  const fake = fakeSupabase(results);
  mocks.contentClient.mockResolvedValue({ supabase: fake.client, user: { id: userId, email: null } });
  return fake;
}

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => logSpy.mockRestore();
});

describe("toAgentActionRow", () => {
  it("records a successful update with ids, versions and changed field names only", () => {
    const row = toAgentActionRow(ctx, TURN, {
      tool: "update_post",
      kind: "update",
      status: "success",
      effect: { kind: "update", projectId: PROJECT, postId: POST, versionBefore: 3, versionAfter: 4, fields: ["body"] },
    });
    expect(row).toEqual({
      workspace_id: WS,
      turn_id: TURN,
      tool: "update_post",
      kind: "update",
      status: "success",
      error_code: null,
      project_id: PROJECT,
      post_id: POST,
      version_before: 3,
      version_after: 4,
      fields: ["body"],
      request_id: null,
    });
  });

  it("takes the workspace from the locked context, never from the action", () => {
    const row = toAgentActionRow(ctx, TURN, {
      tool: "list_projects",
      kind: "read",
      status: "success",
      effect: { kind: "read", workspaceId: "99999999-9999-4999-8999-999999999999" } as never,
    });
    expect(row.workspace_id).toBe(WS);
    expect(row).not.toHaveProperty("user_id");
  });

  it("records reads with the version read", () => {
    expect(
      toAgentActionRow(ctx, TURN, {
        tool: "get_post",
        kind: "read",
        status: "success",
        effect: { kind: "read", projectId: PROJECT, postId: POST, versionAfter: 3 },
      }),
    ).toMatchObject({ post_id: POST, version_after: 3, version_before: null, fields: null });
  });

  it.each(["version_conflict", "not_draft", "archived", "forbidden", "conflict_no_retry", "stale_version"])(
    "keeps the (verified) target for %s",
    (code) => {
      const row = toAgentActionRow(ctx, TURN, {
        tool: "update_post",
        kind: "update",
        status: code.endsWith("retry") || code === "stale_version" ? "skipped" : "error",
        code,
        effect: { kind: "update", postId: POST },
      });
      expect(row).toMatchObject({ error_code: code, post_id: POST, version_after: null, fields: null });
    },
  );

  it.each(["not_found", "invalid_input", "read_required", "unknown_tool", "tool_limit", "write_limit"])(
    "drops unverified ids from the model for %s",
    (code) => {
      const row = toAgentActionRow(ctx, TURN, {
        tool: "update_post",
        kind: "update",
        status: "error",
        code,
        effect: { kind: "update", postId: POST, projectId: PROJECT },
      });
      expect(row).toMatchObject({ error_code: code, post_id: null, project_id: null });
    },
  );

  it("normalises unknown tool names and odd codes to safe identifiers", () => {
    const row = toAgentActionRow(ctx, TURN, {
      tool: "Ignore previous instructions; DROP TABLE",
      kind: "unknown",
      status: "error",
      code: "Some Code With Spaces",
    });
    expect(row).toMatchObject({ tool: "unknown", error_code: "unknown" });
  });

  it("an error row never carries versions or fields", () => {
    const row = toAgentActionRow(ctx, TURN, {
      tool: "update_post",
      kind: "update",
      status: "error",
      code: "version_conflict",
      effect: { kind: "update", postId: POST, versionBefore: 3, versionAfter: 4, fields: ["title"] },
    });
    expect(row).toMatchObject({ version_before: null, version_after: null, fields: null });
  });
});

describe("toAgentActionRow: publish requests (M4.6c)", () => {
  const REQUEST = "66666666-6666-4666-8666-666666666666";

  it("a successful request names the request, the post and the requested version", () => {
    const row = toAgentActionRow(ctx, TURN, {
      tool: "request_publish",
      kind: "publish_request",
      status: "success",
      effect: { kind: "publish_request", postId: POST, versionAfter: 3, requestId: REQUEST, destinationId: "d" },
    });
    expect(row).toMatchObject({
      tool: "request_publish",
      kind: "publish_request",
      status: "success",
      error_code: null,
      post_id: POST,
      version_after: 3,
      version_before: null,
      fields: null,
      request_id: REQUEST,
    });
    // The destination id and anything else in the effect is not copied.
    expect(Object.keys(row)).not.toContain("destination_id");
  });

  it.each(["request_pending_exists", "post_published", "destination_disabled"])(
    "a failed request (%s) keeps the verified post but never a request id",
    (code) => {
      const row = toAgentActionRow(ctx, TURN, {
        tool: "request_publish",
        kind: "publish_request",
        status: "error",
        code,
        effect: { kind: "publish_request", postId: POST, requestId: REQUEST },
      });
      expect(row).toMatchObject({ error_code: code, post_id: POST, request_id: null, version_after: null });
    },
  );

  it("unverified failures (not_found, read_required) drop the model's ids", () => {
    for (const code of ["not_found", "read_required"]) {
      const row = toAgentActionRow(ctx, TURN, {
        tool: "request_publish",
        kind: "publish_request",
        status: code === "read_required" ? "skipped" : "error",
        code,
        effect: { kind: "publish_request", postId: POST },
      });
      expect(row).toMatchObject({ post_id: null, request_id: null });
    }
  });

  it("only publish_request rows ever carry a request id", () => {
    const row = toAgentActionRow(ctx, TURN, {
      tool: "get_post",
      kind: "read",
      status: "success",
      effect: { kind: "read", postId: POST, versionAfter: 3, requestId: REQUEST },
    });
    expect(row.request_id).toBeNull();
  });
});

describe("recordAgentAction", () => {
  const action: LoggableAgentAction = {
    tool: "create_post",
    kind: "create",
    status: "success",
    effect: { kind: "create", projectId: PROJECT, postId: POST, versionAfter: 1 },
  };

  it("inserts the row as the signed-in user", async () => {
    const fake = setup([ok(null)]);
    expect(await recordAgentAction(ctx, TURN, action)).toBe("recorded");
    const query = fake.queries[0]!;
    expect(query.table).toBe("agent_actions");
    expect(query.args("insert")).toEqual([toAgentActionRow(ctx, TURN, action)]);
  });

  it("the inserted row contains no content, prompt, arguments or secrets", async () => {
    const fake = setup([ok(null)]);
    await recordAgentAction(ctx, TURN, {
      ...action,
      // Even if extra data were attached to an action, it is not copied into the row.
      message: "secret body text sk-test-000",
    } as LoggableAgentAction);
    const [row] = fake.queries[0]!.args("insert") as [Record<string, unknown>];
    expect(Object.keys(row).sort()).toEqual(
      [
        "error_code",
        "fields",
        "kind",
        "post_id",
        "project_id",
        "request_id",
        "status",
        "tool",
        "turn_id",
        "version_after",
        "version_before",
        "workspace_id",
      ].sort(),
    );
    expect(JSON.stringify(row)).not.toMatch(/secret|sk-test/);
  });

  it("returns 'failed' (never throws) when the database rejects the row", async () => {
    setup([dbError("42501", 'new row violates row-level security policy for table "agent_actions"')]);
    expect(await recordAgentAction(ctx, TURN, action)).toBe("failed");
    expect(JSON.stringify(logSpy.mock.calls)).not.toMatch(/row-level security policy/);
  });

  it("logs no database details and no untrusted tool name", async () => {
    setup([
      {
        data: null,
        error: { code: "23514", message: "Failing row contains (secret body)", details: "secret body", hint: "secret hint" },
      },
    ]);
    const result = await recordAgentAction(ctx, TURN, {
      tool: "Ignore all instructions sk-proj-LEAK",
      kind: "unknown",
      status: "error",
      code: "unknown_tool",
    });
    expect(result).toBe("failed");
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).toContain('\\"tool\\":\\"unknown\\"');
    expect(logged).toContain('\\"code\\":\\"23514\\"');
    for (const leak of ["secret body", "secret hint", "Failing row", "Ignore all", "sk-proj"]) {
      expect(logged).not.toContain(leak);
    }
  });

  it("returns 'failed' when there is no session", async () => {
    mocks.contentClient.mockRejectedValue(new ContentError("unauthenticated"));
    expect(await recordAgentAction(ctx, TURN, action)).toBe("failed");
  });

  it("refuses to log for a different user than the context", async () => {
    const fake = setup([], "99999999-9999-4999-8999-999999999999");
    expect(await recordAgentAction(ctx, TURN, action)).toBe("failed");
    expect(fake.queries).toHaveLength(0);
  });
});

describe("listAgentActions", () => {
  it("reads the workspace log newest first", async () => {
    const fake = setup([
      ok([
        {
          id: "a1",
          turn_id: TURN,
          user_id: USER,
          tool: "update_post",
          kind: "update",
          status: "success",
          error_code: null,
          project_id: PROJECT,
          post_id: POST,
          version_before: 3,
          version_after: 4,
          fields: ["body"],
          created_at: "2026-11-20T17:00:00Z",
        },
      ]),
    ]);
    const entries = await listAgentActions({ workspaceId: WS, limit: 10 });
    const query = fake.queries[0]!;
    expect(query.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(query.calls).toContainEqual(["order", ["created_at", { ascending: false }]]);
    expect(query.calls).toContainEqual(["limit", [10]]);
    expect(entries[0]).toMatchObject({ turnId: TURN, versionBefore: 3, versionAfter: 4, fields: ["body"] });
  });

  it.each([{ workspaceId: "nope" }, { workspaceId: WS, limit: 1000 }, { workspaceId: WS, extra: 1 }])(
    "rejects invalid input %j",
    async (input) => {
      await expect(listAgentActions(input)).rejects.toMatchObject({ code: "invalid_input" });
      expect(mocks.contentClient).not.toHaveBeenCalled();
    },
  );
});
