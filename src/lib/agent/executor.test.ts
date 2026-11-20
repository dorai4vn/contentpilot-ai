import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  getMyWorkspace: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  listPosts: vi.fn(),
  getPost: vi.fn(),
  createPost: vi.fn(),
  patchPost: vi.fn(),
}));
vi.mock("@/lib/workspaces/queries", () => ({ getMyWorkspace: mocks.getMyWorkspace }));
vi.mock("@/lib/content/projects", () => ({ listProjects: mocks.listProjects, getProject: mocks.getProject }));
vi.mock("@/lib/content/posts", () => ({
  listPosts: mocks.listPosts,
  getPost: mocks.getPost,
  createPost: mocks.createPost,
  patchPost: mocks.patchPost,
}));

import { ContentError } from "@/lib/content/errors";

import { type AgentToolContext, createAgentToolContext, executeAgentTool } from "./executor";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "u@example.test" };
const WS = "22222222-2222-4222-8222-222222222222";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";

const project = {
  id: PROJECT,
  workspaceId: WS,
  name: "Blog",
  description: "Company blog",
  createdBy: USER.id,
  archivedAt: null,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:00:00Z",
};

const post = {
  id: POST,
  workspaceId: WS,
  projectId: PROJECT,
  title: "Hello",
  body: "Body text",
  status: "draft" as const,
  scheduledFor: "2026-12-05T03:04:05.123456+00:00",
  version: 3,
  lastChangeSource: "user" as const,
  archivedAt: null,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:05:00Z",
  createdBy: USER.id,
  updatedBy: USER.id,
};

const dataFns = [mocks.listProjects, mocks.getProject, mocks.listPosts, mocks.getPost, mocks.createPost, mocks.patchPost];

let ctx: AgentToolContext;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getMyWorkspace.mockResolvedValue({ id: WS, name: "WS", role: "member", createdAt: "2026-11-20T09:00:00Z" });
  ctx = await createAgentToolContext(USER, WS);
  vi.clearAllMocks();
});

const noDataCalls = () => {
  for (const fn of dataFns) expect(fn).not.toHaveBeenCalled();
};

describe("createAgentToolContext (workspace lock)", () => {
  it("locks to a workspace the user belongs to and is immutable", async () => {
    mocks.getMyWorkspace.mockResolvedValue({ id: WS, name: "WS", role: "admin", createdAt: "x" });
    const context = await createAgentToolContext(USER, WS.toUpperCase());
    expect(context).toEqual({ workspaceId: WS, userId: USER.id, role: "admin" });
    expect(mocks.getMyWorkspace).toHaveBeenCalledWith(USER, WS);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("rejects a workspace the user is not a member of", async () => {
    mocks.getMyWorkspace.mockResolvedValue(null);
    await expect(createAgentToolContext(USER, OTHER_WS)).rejects.toMatchObject({ code: "not_found" });
  });

  it.each(["nope", "", null, 42])("rejects an invalid workspace id %j without a query", async (value) => {
    await expect(createAgentToolContext(USER, value)).rejects.toBeInstanceOf(ContentError);
    expect(mocks.getMyWorkspace).not.toHaveBeenCalled();
  });
});

describe("dispatch and argument validation", () => {
  it("rejects unknown tools (including risky names)", async () => {
    for (const name of ["delete_post", "publish_post", "archive_post", "set_status", "__proto__", "toString"]) {
      expect(await executeAgentTool(ctx, name, {})).toMatchObject({ ok: false, code: "unknown_tool" });
    }
    noDataCalls();
  });

  it("parses JSON-string arguments as sent by OpenAI", async () => {
    mocks.getPost.mockResolvedValue(post);
    const result = await executeAgentTool(ctx, "get_post", JSON.stringify({ post_id: POST }));
    expect(result.ok).toBe(true);
  });

  it.each(["{not json", "[1,2", "null-ish"])("rejects malformed JSON %j", async (raw) => {
    expect(await executeAgentTool(ctx, "get_post", raw)).toMatchObject({ ok: false, code: "invalid_input" });
    noDataCalls();
  });

  it.each([
    ["list_projects", { workspace_id: OTHER_WS }],
    ["list_posts", { project_id: PROJECT, status: "published" }],
    ["get_post", { post_id: "not-a-uuid" }],
    ["get_post", { post_id: POST, workspace_id: OTHER_WS }],
    ["create_post", { project_id: PROJECT, title: "T", body: "", scheduled_for: null, status: "ready" }],
    ["create_post", { project_id: PROJECT, title: "T", body: "", scheduled_for: null, workspace_id: OTHER_WS }],
    ["update_post", { post_id: POST, title: "T", body: null, scheduled_for: null, clear_schedule: null }],
    ["update_post", { post_id: POST, expected_version: 3, title: "T", body: null, scheduled_for: null, clear_schedule: null, status: "ready" }],
    ["update_post", { post_id: POST, expected_version: 3, title: "T", body: null, scheduled_for: null, clear_schedule: null, version: 9 }],
  ])("%s: strict validation rejects %j before any data access", async (name, args) => {
    const result = await executeAgentTool(ctx, name, args);
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    noDataCalls();
  });

  it("names the forbidden field in the error", async () => {
    const result = await executeAgentTool(ctx, "get_post", { post_id: POST, workspace_id: OTHER_WS });
    expect(result).toMatchObject({ ok: false, fieldErrors: { workspace_id: "Không được phép gửi trường này." } });
  });
});

describe("read tools", () => {
  it("list_projects uses the locked workspace", async () => {
    mocks.listProjects.mockResolvedValue([project]);
    const result = await executeAgentTool(ctx, "list_projects", {});
    expect(mocks.listProjects).toHaveBeenCalledWith({ workspaceId: WS });
    expect(result).toEqual({
      ok: true,
      tool: "list_projects",
      data: { projects: [{ id: PROJECT, name: "Blog", description: "Company blog" }] },
      effect: { kind: "read" },
    });
  });

  it("list_posts checks the project belongs to the workspace", async () => {
    mocks.getProject.mockResolvedValue(project);
    mocks.listPosts.mockResolvedValue([post]);
    const result = await executeAgentTool(ctx, "list_posts", { project_id: PROJECT, status: "draft" });
    expect(mocks.listPosts).toHaveBeenCalledWith({ projectId: PROJECT, status: "draft" });
    expect(result).toMatchObject({ ok: true, data: { posts: [{ id: POST, version: 3 }] } });
    expect(JSON.stringify(result)).not.toContain("Body text");
  });

  it("list_posts in another workspace looks like not found", async () => {
    mocks.getProject.mockResolvedValue({ ...project, workspaceId: OTHER_WS });
    const result = await executeAgentTool(ctx, "list_posts", { project_id: PROJECT, status: null });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(mocks.listPosts).not.toHaveBeenCalled();
  });

  it("get_post returns the body and the version needed for updates", async () => {
    mocks.getPost.mockResolvedValue(post);
    const result = await executeAgentTool(ctx, "get_post", { post_id: POST });
    expect(result).toMatchObject({
      ok: true,
      data: { post: { id: POST, body: "Body text", version: 3, scheduled_for: post.scheduledFor, archived: false } },
      effect: { kind: "read", postId: POST, versionAfter: 3 },
    });
  });

  it("get_post of another workspace or an invisible post is not found", async () => {
    mocks.getPost.mockResolvedValueOnce({ ...post, workspaceId: OTHER_WS }).mockResolvedValueOnce(null);
    for (let i = 0; i < 2; i++) {
      const result = await executeAgentTool(ctx, "get_post", { post_id: POST });
      expect(result).toMatchObject({ ok: false, code: "not_found" });
      expect(JSON.stringify(result)).not.toContain("Body text");
    }
  });
});

describe("create_post", () => {
  const args = { project_id: PROJECT, title: "  New post ", body: "Draft body", scheduled_for: "2026-12-01T09:00:00+07:00" };

  it("always creates a draft in the locked workspace, as the agent", async () => {
    mocks.getProject.mockResolvedValue(project);
    mocks.createPost.mockResolvedValue({ ...post, id: POST, version: 1, title: "New post" });
    const result = await executeAgentTool(ctx, "create_post", args);

    expect(mocks.createPost).toHaveBeenCalledTimes(1);
    expect(mocks.createPost).toHaveBeenCalledWith(
      {
        workspaceId: WS,
        projectId: PROJECT,
        title: "New post",
        body: "Draft body",
        status: "draft",
        scheduledFor: "2026-12-01T02:00:00.000Z",
      },
      { changeSource: "agent" },
    );
    expect(result).toMatchObject({
      ok: true,
      effect: { kind: "create", projectId: PROJECT, postId: POST, versionAfter: 1 },
    });
    expect(JSON.stringify((result as { data: unknown }).data)).not.toContain("Body text");
  });

  it("refuses a project of another workspace without writing", async () => {
    mocks.getProject.mockResolvedValue({ ...project, workspaceId: OTHER_WS });
    expect(await executeAgentTool(ctx, "create_post", args)).toMatchObject({ ok: false, code: "not_found" });
    expect(mocks.createPost).not.toHaveBeenCalled();
  });

  it("refuses an archived project without writing", async () => {
    mocks.getProject.mockResolvedValue({ ...project, archivedAt: "2026-11-20T11:00:00Z" });
    expect(await executeAgentTool(ctx, "create_post", args)).toMatchObject({ ok: false, code: "archived" });
    expect(mocks.createPost).not.toHaveBeenCalled();
  });

  it("reports an RLS rejection as forbidden with a safe message", async () => {
    mocks.getProject.mockResolvedValue(project);
    mocks.createPost.mockRejectedValue(new ContentError("forbidden"));
    const result = await executeAgentTool(ctx, "create_post", args);
    expect(result).toMatchObject({
      ok: false,
      code: "forbidden",
      error: "Bạn không có quyền thực hiện thao tác này.",
      effect: { kind: "create", projectId: PROJECT },
    });
  });

  it("hides unexpected errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getProject.mockResolvedValue(project);
    mocks.createPost.mockRejectedValue(new Error('relation "secret_table" does not exist'));
    const result = await executeAgentTool(ctx, "create_post", args);
    expect(result).toMatchObject({ ok: false, code: "unknown" });
    expect(JSON.stringify(result)).not.toMatch(/secret_table/);
    log.mockRestore();
  });
});

describe("update_post", () => {
  const base = { post_id: POST, expected_version: 3, title: null, body: null, scheduled_for: null, clear_schedule: null };

  it("sends only the requested fields, draft-only, workspace-locked, as the agent", async () => {
    mocks.patchPost.mockResolvedValue({ ...post, body: "Shorter", version: 4 });
    const result = await executeAgentTool(ctx, "update_post", { ...base, body: "Shorter" });

    expect(mocks.patchPost).toHaveBeenCalledTimes(1);
    expect(mocks.patchPost).toHaveBeenCalledWith(
      { postId: POST, expectedVersion: 3, body: "Shorter" },
      { changeSource: "agent", workspaceId: WS, requireStatus: "draft" },
    );
    expect(result).toMatchObject({
      ok: true,
      effect: { kind: "update", postId: POST, versionBefore: 3, versionAfter: 4, fields: ["body"] },
    });
  });

  it("omits untouched fields so their stored values (incl. schedule precision) are kept", async () => {
    mocks.patchPost.mockResolvedValue({ ...post, title: "T", version: 4 });
    await executeAgentTool(ctx, "update_post", { ...base, title: "T" });
    const [patch] = mocks.patchPost.mock.calls[0]!;
    expect(Object.keys(patch).sort()).toEqual(["expectedVersion", "postId", "title"]);
  });

  it("sets a new schedule or clears it only when asked", async () => {
    mocks.patchPost.mockResolvedValue({ ...post, version: 4 });
    await executeAgentTool(ctx, "update_post", { ...base, scheduled_for: "2026-12-01T09:00:00+07:00" });
    await executeAgentTool(ctx, "update_post", { ...base, clear_schedule: true });
    expect(mocks.patchPost.mock.calls[0]![0]).toEqual({
      postId: POST,
      expectedVersion: 3,
      scheduledFor: "2026-12-01T02:00:00.000Z",
    });
    expect(mocks.patchPost.mock.calls[1]![0]).toEqual({ postId: POST, expectedVersion: 3, scheduledFor: null });
  });

  it("reports a version conflict once, without retrying", async () => {
    mocks.patchPost.mockRejectedValue(new ContentError("version_conflict"));
    const result = await executeAgentTool(ctx, "update_post", { ...base, body: "x" });
    expect(mocks.patchPost).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, code: "version_conflict", effect: { kind: "update", postId: POST } });
    expect((result as { error: string }).error).toMatch(/Không ghi đè/);
  });

  it("refuses posts that are not drafts", async () => {
    mocks.patchPost.mockRejectedValue(new ContentError("not_allowed_status"));
    const result = await executeAgentTool(ctx, "update_post", { ...base, title: "T" });
    expect(result).toMatchObject({
      ok: false,
      code: "not_draft",
      error: "Trợ lý AI chỉ được sửa bài viết ở trạng thái Bản nháp.",
    });
  });

  it.each(["not_found", "archived", "forbidden"] as const)("passes %s through safely", async (code) => {
    mocks.patchPost.mockRejectedValue(new ContentError(code));
    expect(await executeAgentTool(ctx, "update_post", { ...base, title: "T" })).toMatchObject({ ok: false, code });
  });

  it("rejects contradictory schedule instructions and empty updates", async () => {
    expect(
      await executeAgentTool(ctx, "update_post", { ...base, scheduled_for: "2026-12-01T09:00:00Z", clear_schedule: true }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await executeAgentTool(ctx, "update_post", base)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.patchPost).not.toHaveBeenCalled();
  });
});

describe("server log never contains sensitive data", () => {
  it("an unexpected data-layer error is logged as class + code only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitive = Object.assign(
      new Error('null value violates not-null constraint. Failing row contains (Body text, sk-proj-LEAKED0000000000000000)'),
      { code: "XX000", details: "Failing row contains (Body text)", hint: "secret hint" },
    );
    mocks.getPost.mockRejectedValue(sensitive);

    const result = await executeAgentTool(ctx, "get_post", { post_id: POST });

    expect(result).toMatchObject({ ok: false, code: "unknown" });
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("get_post");
    expect(logged).toContain('\\"code\\":\\"XX000\\"');
    for (const leak of ["Body text", "sk-proj", "Failing row", "secret hint", "not-null", "at "]) {
      expect(logged).not.toContain(leak);
    }
    spy.mockRestore();
  });
});
