import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  revalidatePath: vi.fn(),
  requestPostPublish: vi.fn(),
  approvePublishRequest: vi.fn(),
  rejectPublishRequest: vi.fn(),
  cancelPublishRequest: vi.fn(),
  getPublishRequest: vi.fn(),
  listPublishRequests: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/dal", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/content/publish-requests", () => ({
  requestPostPublish: mocks.requestPostPublish,
  approvePublishRequest: mocks.approvePublishRequest,
  rejectPublishRequest: mocks.rejectPublishRequest,
  cancelPublishRequest: mocks.cancelPublishRequest,
  getPublishRequest: mocks.getPublishRequest,
  listPublishRequests: mocks.listPublishRequests,
}));

import { CONTENT_ERROR_MESSAGES, ContentError, type ContentErrorCode } from "@/lib/content/errors";

import * as actions from "./publish";
import { approvePublishAction, bulkApprovePublishAction, cancelPublishAction, rejectPublishAction, requestPublishAction } from "./publish";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: null };
const WS = "22222222-2222-4222-8222-222222222222";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";
const REQUEST = "66666666-6666-4666-8666-666666666666";
const DEST = "88888888-8888-4888-8888-888888888888";

const pending = {
  id: REQUEST,
  workspaceId: WS,
  postId: POST,
  postVersion: 3,
  status: "pending" as const,
  displayStatus: "pending" as const,
  requestSource: "user" as const,
  agentTurnId: null,
  reason: null,
  requestedBy: USER.id,
  requestedAt: "2026-11-20T10:00:00Z",
  expiresAt: "2026-11-27T10:00:00Z",
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  cancelReason: null,
};
const published = {
  id: POST,
  workspaceId: WS,
  projectId: PROJECT,
  title: "Hello",
  status: "published" as const,
  version: 4,
  publishedAt: "2026-11-20T12:00:00Z",
  updatedBy: USER.id,
};

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

const requestForm = () => form({ workspaceId: WS, postId: POST, expectedVersion: "3", destinationId: DEST, reason: " Sẵn sàng " });
const approveForm = (extra: Record<string, string> = {}) =>
  form({ workspaceId: WS, requestId: REQUEST, expectedPostVersion: "3", expectedDestinationId: DEST, confirm: "approve", ...extra });
const rejectForm = () => form({ workspaceId: WS, requestId: REQUEST, note: "Cần sửa" });
const cancelForm = () => form({ workspaceId: WS, requestId: REQUEST });

const writeFns = [mocks.requestPostPublish, mocks.approvePublishRequest, mocks.rejectPublishRequest, mocks.cancelPublishRequest];
const failure = (code: ContentErrorCode) => ({ ok: false, code, error: CONTENT_ERROR_MESSAGES[code] });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.getPublishRequest.mockResolvedValue({ request: pending, events: [] });
});

describe("module surface", () => {
  it("exports exactly the human actions", () => {
    expect(Object.keys(actions).sort()).toEqual(
      ["approvePublishAction", "bulkApprovePublishAction", "cancelPublishAction", "rejectPublishAction", "requestPublishAction"].sort(),
    );
  });
});

describe("signed-out callers", () => {
  it.each([
    ["request", () => requestPublishAction(null, requestForm())],
    ["approve", () => approvePublishAction(null, approveForm())],
    ["reject", () => rejectPublishAction(null, rejectForm())],
    ["cancel", () => cancelPublishAction(null, cancelForm())],
  ])("%s: requireUser redirects before anything else runs", async (_name, run) => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(run()).rejects.toThrow("NEXT_REDIRECT");
    for (const fn of [...writeFns, mocks.getPublishRequest]) expect(fn).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("requestPublishAction", () => {
  it("files a user request scoped to the page's workspace and revalidates", async () => {
    mocks.requestPostPublish.mockResolvedValue(pending);
    const result = await requestPublishAction(
      null,
      form({ workspaceId: WS, postId: POST, expectedVersion: "3", destinationId: DEST, reason: " Sẵn sàng ", $ACTION_ID_x: "" }),
    );

    expect(result).toEqual({ ok: true, data: { workspaceId: WS, postId: POST, requestId: REQUEST, requestStatus: "pending" } });
    // Only ids, version and reason as input; the workspace only as a scope guard; never a source/agent option.
    expect(mocks.requestPostPublish).toHaveBeenCalledWith(
      { postId: POST, expectedVersion: 3, reason: "Sẵn sàng", destinationId: DEST },
      { workspaceId: WS },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}/posts/${POST}`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}/approvals`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}`);
  });

  it("never approves: sending a request only files it", async () => {
    mocks.requestPostPublish.mockResolvedValue(pending);
    await requestPublishAction(null, requestForm());
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
    expect(mocks.rejectPublishRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["CP409 version conflict", "version_conflict"],
    ["CP412 pending exists", "request_pending_exists"],
    ["CP422 already published", "post_published"],
    ["CP404 other workspace / not visible", "not_found"],
    ["CP423 archived", "archived"],
  ] as const)("%s -> Vietnamese %s message", async (_label, code) => {
    mocks.requestPostPublish.mockRejectedValue(new ContentError(code));
    const result = await requestPublishAction(null, requestForm());
    expect(result).toEqual(failure(code));
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("approvePublishAction", () => {
  it("owner approves explicitly: checks the workspace, then publishes", async () => {
    mocks.approvePublishRequest.mockResolvedValue(published);
    const result = await approvePublishAction(null, approveForm());

    expect(result).toEqual({
      ok: true,
      data: { workspaceId: WS, postId: POST, requestId: REQUEST, requestStatus: "approved", postStatus: "published", postVersion: 4 },
    });
    expect(mocks.getPublishRequest).toHaveBeenCalledWith({ requestId: REQUEST });
    expect(mocks.approvePublishRequest).toHaveBeenCalledWith({
      requestId: REQUEST,
      expectedPostVersion: 3,
      expectedDestinationId: DEST,
    });
    expect(mocks.getPublishRequest.mock.invocationCallOrder[0]).toBeLessThan(mocks.approvePublishRequest.mock.invocationCallOrder[0]!);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}/posts/${POST}`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}/p/${PROJECT}`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}/approvals`);
  });

  it("member tries to approve: forbidden message, nothing revalidated", async () => {
    mocks.approvePublishRequest.mockRejectedValue(new ContentError("forbidden"));
    const result = await approvePublishAction(null, approveForm());
    expect(result).toEqual(failure("forbidden"));
    expect(result).toMatchObject({ error: "Bạn không có quyền thực hiện thao tác này." });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("outsider (request not visible): not_found, approve never called", async () => {
    mocks.getPublishRequest.mockResolvedValue(null);
    expect(await approvePublishAction(null, approveForm())).toEqual(failure("not_found"));
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
  });

  it("request from another workspace than the page: not_found, approve never called", async () => {
    mocks.getPublishRequest.mockResolvedValue({ request: { ...pending, workspaceId: OTHER_WS }, events: [] });
    expect(await approvePublishAction(null, approveForm())).toEqual(failure("not_found"));
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
  });

  it("repeated approval: request_closed message", async () => {
    mocks.approvePublishRequest.mockRejectedValue(new ContentError("request_closed"));
    const result = await approvePublishAction(null, approveForm());
    expect(result).toEqual(failure("request_closed"));
    expect((result as { error: string }).error).toMatch(/đã được xử lý/);
  });

  it("expired request: request_expired message", async () => {
    mocks.approvePublishRequest.mockRejectedValue(new ContentError("request_expired"));
    const result = await approvePublishAction(null, approveForm());
    expect(result).toEqual(failure("request_expired"));
    expect((result as { error: string }).error).toMatch(/hết hạn sau 7 ngày/);
  });

  it("version conflict: version_conflict message", async () => {
    mocks.approvePublishRequest.mockRejectedValue(new ContentError("version_conflict"));
    expect(await approvePublishAction(null, approveForm())).toEqual(failure("version_conflict"));
  });

  it("already published: post_published message", async () => {
    mocks.approvePublishRequest.mockRejectedValue(new ContentError("post_published"));
    const result = await approvePublishAction(null, approveForm());
    expect((result as { error: string }).error).toMatch(/đã được xuất bản/);
  });

  it("unexpected errors stay generic and are not leaked", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.approvePublishRequest.mockRejectedValue(Object.assign(new Error("relation secret_table"), { code: "XX000" }));
    const result = await approvePublishAction(null, approveForm());
    expect(result).toEqual(failure("unknown"));
    expect(JSON.stringify([result, log.mock.calls])).not.toMatch(/secret_table/);
    log.mockRestore();
  });

  describe("no implicit approval", () => {
    it("without the explicit confirm field nothing is approved", async () => {
      const fd = form({ workspaceId: WS, requestId: REQUEST, expectedPostVersion: "3" });
      expect(await approvePublishAction(null, fd)).toMatchObject({ ok: false, code: "invalid_input" });
      expect(mocks.getPublishRequest).not.toHaveBeenCalled();
      expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
    });

    it.each(["yes", "true", "1", "Approve", "approved", ""])("confirm=%j is not an approval", async (confirm) => {
      expect(await approvePublishAction(null, approveForm({ confirm }))).toMatchObject({ ok: false, code: "invalid_input" });
      expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
    });

    it("reject and cancel forms never approve", async () => {
      mocks.rejectPublishRequest.mockResolvedValue({ ...pending, status: "rejected" });
      mocks.cancelPublishRequest.mockResolvedValue({ ...pending, status: "cancelled" });
      await rejectPublishAction(null, rejectForm());
      await cancelPublishAction(null, cancelForm());
      expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
    });

    it("a reject form posted to the approve action is not an approval", async () => {
      expect(await approvePublishAction(null, rejectForm())).toMatchObject({ ok: false, code: "invalid_input" });
      expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
    });

    it("importing the actions module performs no data access", async () => {
      vi.resetModules();
      vi.clearAllMocks();
      await import("./publish");
      for (const fn of [...writeFns, mocks.getPublishRequest, mocks.listPublishRequests]) expect(fn).not.toHaveBeenCalled();
    });
  });
});

describe("destination scope (M4.6)", () => {
  it("a request form without its destination is rejected (no implicit destination from the UI)", async () => {
    const result = await requestPublishAction(null, form({ workspaceId: WS, postId: POST, expectedVersion: "3" }));
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.requestPostPublish).not.toHaveBeenCalled();
  });

  it("an approval form without the destination the approver saw is rejected", async () => {
    const fd = form({ workspaceId: WS, requestId: REQUEST, expectedPostVersion: "3", confirm: "approve" });
    expect(await approvePublishAction(null, fd)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
  });

  it.each(["nope", ""])("a malformed destination id %j is rejected", async (destinationId) => {
    expect(await approvePublishAction(null, approveForm({ expectedDestinationId: destinationId }))).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["destination_disabled", /tạm ngừng/],
    ["destination_mismatch", /không khớp/],
  ] as const)("%s -> Vietnamese message", async (code, message) => {
    mocks.approvePublishRequest.mockRejectedValue(new ContentError(code));
    const result = await approvePublishAction(null, approveForm());
    expect(result).toEqual(failure(code));
    expect((result as { error: string }).error).toMatch(message);
  });

  it("a disabled destination when requesting -> destination_disabled", async () => {
    mocks.requestPostPublish.mockRejectedValue(new ContentError("destination_disabled"));
    expect(await requestPublishAction(null, requestForm())).toEqual(failure("destination_disabled"));
  });
});

describe("rejectPublishAction / cancelPublishAction", () => {
  it("admin rejects with a trimmed note", async () => {
    mocks.rejectPublishRequest.mockResolvedValue({ ...pending, status: "rejected" });
    const result = await rejectPublishAction(null, form({ workspaceId: WS, requestId: REQUEST, note: "  Cần sửa tiêu đề " }));
    expect(result).toMatchObject({ ok: true, data: { requestStatus: "rejected", postId: POST } });
    expect(mocks.rejectPublishRequest).toHaveBeenCalledWith({ requestId: REQUEST, note: "Cần sửa tiêu đề" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}/posts/${POST}`);
  });

  it("member rejecting: forbidden", async () => {
    mocks.rejectPublishRequest.mockRejectedValue(new ContentError("forbidden"));
    expect(await rejectPublishAction(null, rejectForm())).toEqual(failure("forbidden"));
  });

  it("requester cancels; cancelling again: request_closed", async () => {
    mocks.cancelPublishRequest.mockResolvedValueOnce({ ...pending, status: "cancelled", cancelReason: "withdrawn" });
    expect(await cancelPublishAction(null, cancelForm())).toMatchObject({ ok: true, data: { requestStatus: "cancelled" } });
    mocks.cancelPublishRequest.mockRejectedValueOnce(new ContentError("request_closed"));
    expect(await cancelPublishAction(null, cancelForm())).toEqual(failure("request_closed"));
  });

  it.each([
    ["reject", () => rejectPublishAction(null, rejectForm()), mocks.rejectPublishRequest],
    ["cancel", () => cancelPublishAction(null, cancelForm()), mocks.cancelPublishRequest],
  ])("%s: a request of another workspace is not_found", async (_name, run, fn) => {
    mocks.getPublishRequest.mockResolvedValue({ request: { ...pending, workspaceId: OTHER_WS }, events: [] });
    expect(await run()).toEqual(failure("not_found"));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("forged input", () => {
  const forged = [
    "userId",
    "user_id",
    "requestedBy",
    "requested_by",
    "decidedBy",
    "decided_by",
    "approverId",
    "role",
    "status",
    "approved",
    "published",
    "postStatus",
    "source",
    "agentTurnId",
    "decidedAt",
  ];

  it.each(forged)("request: rejects %s", async (key) => {
    const fd = requestForm();
    fd.append(key, "x");
    const result = await requestPublishAction(null, fd);
    expect(result).toMatchObject({ ok: false, code: "invalid_input", fieldErrors: { [key]: "Không được phép gửi trường này." } });
    expect(mocks.requestPostPublish).not.toHaveBeenCalled();
  });

  it.each(forged)("approve: rejects %s", async (key) => {
    const result = await approvePublishAction(null, approveForm({ [key]: "x" }));
    expect(result).toMatchObject({ ok: false, code: "invalid_input", fieldErrors: { [key]: "Không được phép gửi trường này." } });
    expect(mocks.getPublishRequest).not.toHaveBeenCalled();
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
  });

  it.each(forged)("reject/cancel: rejects %s", async (key) => {
    const r = rejectForm();
    r.append(key, "x");
    const c = cancelForm();
    c.append(key, "x");
    expect(await rejectPublishAction(null, r)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await cancelPublishAction(null, c)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.rejectPublishRequest).not.toHaveBeenCalled();
    expect(mocks.cancelPublishRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["missing workspaceId", () => approvePublishAction(null, form({ requestId: REQUEST, expectedPostVersion: "3", confirm: "approve" }))],
    ["bad request id", () => approvePublishAction(null, approveForm({ requestId: "nope" }))],
    ["bad version", () => approvePublishAction(null, approveForm({ expectedPostVersion: "1.5" }))],
    ["zero version", () => requestPublishAction(null, form({ workspaceId: WS, postId: POST, expectedVersion: "0" }))],
    ["reason too long", () => requestPublishAction(null, form({ workspaceId: WS, postId: POST, expectedVersion: "3", reason: "x".repeat(501) }))],
    ["note too long", () => rejectPublishAction(null, form({ workspaceId: WS, requestId: REQUEST, note: "x".repeat(501) }))],
  ])("rejects %s", async (_name, run) => {
    expect(await run()).toMatchObject({ ok: false, code: "invalid_input" });
    for (const fn of writeFns) expect(fn).not.toHaveBeenCalled();
  });

  it("rejects repeated fields and files", async () => {
    const repeated = approveForm();
    repeated.append("requestId", REQUEST);
    expect(await approvePublishAction(null, repeated)).toMatchObject({ ok: false, code: "invalid_input" });
    const withFile = form({ workspaceId: WS, requestId: REQUEST, confirm: "approve" });
    withFile.append("expectedPostVersion", new Blob(["3"]), "v.txt");
    expect(await approvePublishAction(null, withFile)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
  });
});

describe("human and agent paths are separate", () => {
  const root = process.cwd();
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }
  const agentFiles = [...sources(join(root, "src/lib/agent")), ...sources(join(root, "src/app/api/agent"))];

  it("agent code imports no Server Action and no approve/reject/cancel function", () => {
    expect(agentFiles.length).toBeGreaterThan(5);
    for (const file of agentFiles) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/(from|import\()\s*["'][^"']*\/_actions\//);
      expect(text, file).not.toMatch(/approvePublishRequest|rejectPublishRequest|cancelPublishRequest|approve_publish_request|reject_publish_request/);
      expect(text, file).not.toMatch(/approvePublishAction|rejectPublishAction|cancelPublishAction/);
    }
  });

  it("the actions never read request headers to decide who is acting", () => {
    const text = readFileSync(join(root, "src/app/_actions/content/publish.ts"), "utf8");
    expect(text).not.toMatch(/from "next\/headers"/);
    expect(text).not.toMatch(/x-contentpilot-actor/);
  });

  it("the actions never call database RPCs directly", () => {
    const text = readFileSync(join(root, "src/app/_actions/content/publish.ts"), "utf8");
    expect(text).not.toMatch(/\.rpc\(|createClient|@supabase/);
  });

  it("CSRF: no serverActions.allowedOrigins override (Next.js same-origin check applies)", () => {
    const config = readFileSync(join(root, "next.config.ts"), "utf8");
    expect(config).not.toMatch(/allowedOrigins/);
  });
});

describe("bulkApprovePublishAction", () => {
  const R2 = "77777777-7777-4777-8777-777777777777";
  const item = (requestId: string, v = 3) => ({
    requestId,
    expectedPostVersion: v,
    expectedDestinationId: DEST,
  });
  const input = (
    items: ReturnType<typeof item>[],
    extra: Record<string, unknown> = {},
  ) => ({
    workspaceId: WS,
    confirm: "approve",
    items,
    ...extra,
  });

  it("requires a signed-in user", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(
      bulkApprovePublishAction(input([item(REQUEST)])),
    ).rejects.toThrow();
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
  });

  it("rejects empty, oversized, duplicated, unconfirmed and unknown-field input", async () => {
    const many = Array.from({ length: 31 }, (_, i) =>
      item(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
    );
    for (const bad of [
      input([]),
      input(many),
      input([item(REQUEST), item(REQUEST)]),
      input([item(REQUEST)], { confirm: "yes" }),
      input([item(REQUEST)], { approvedBy: USER.id }),
      null,
    ]) {
      expect(await bulkApprovePublishAction(bad)).toEqual(
        failure("invalid_input"),
      );
    }
    expect(mocks.approvePublishRequest).not.toHaveBeenCalled();
  });

  it("approves one item", async () => {
    mocks.approvePublishRequest.mockResolvedValue(published);
    const result = await bulkApprovePublishAction(input([item(REQUEST)]));
    expect(result).toEqual({
      ok: true,
      data: {
        workspaceId: WS,
        results: [
          {
            requestId: REQUEST,
            ok: true,
            postStatus: "published",
            postVersion: 4,
          },
        ],
      },
    });
    expect(mocks.approvePublishRequest).toHaveBeenCalledWith({
      requestId: REQUEST,
      expectedPostVersion: 3,
      expectedDestinationId: DEST,
    });
  });

  it("judges items individually and sequentially: mixed stale / forbidden / cross-workspace", async () => {
    const order: string[] = [];
    mocks.getPublishRequest.mockImplementation(
      async ({ requestId }: { requestId: string }) => ({
        request: {
          ...pending,
          id: requestId,
          workspaceId:
            requestId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
              ? OTHER_WS
              : WS,
        },
        events: [],
      }),
    );
    mocks.approvePublishRequest.mockImplementation(
      async ({ requestId }: { requestId: string }) => {
        order.push(requestId);
        if (requestId === R2) throw new ContentError("version_conflict");
        if (requestId === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
          throw new ContentError("forbidden");
        return published;
      },
    );
    const result = await bulkApprovePublishAction(
      input([
        item(REQUEST),
        item(R2),
        item("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        item("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results.map((r) => (r.ok ? "ok" : r.code))).toEqual([
      "ok",
      "version_conflict",
      "not_found",
      "forbidden",
    ]);
    expect(order).toEqual([
      REQUEST,
      R2,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
  });

  it("a repeated submit is closed by the data layer, not approved twice", async () => {
    mocks.approvePublishRequest
      .mockResolvedValueOnce(published)
      .mockRejectedValueOnce(new ContentError("request_closed"));
    const first = await bulkApprovePublishAction(input([item(REQUEST)]));
    const second = await bulkApprovePublishAction(input([item(REQUEST)]));
    expect(first.ok && first.data.results[0]?.ok).toBe(true);
    expect(second.ok && second.data.results[0]).toMatchObject({
      ok: false,
      code: "request_closed",
    });
  });
});
