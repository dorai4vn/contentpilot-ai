import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  revalidatePath: vi.fn(),
  createPost: vi.fn(),
  updatePost: vi.fn(),
  getPost: vi.fn(),
  archivePost: vi.fn(),
  restorePost: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/dal", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/content/posts", () => ({
  createPost: mocks.createPost,
  updatePost: mocks.updatePost,
  getPost: mocks.getPost,
  archivePost: mocks.archivePost,
  restorePost: mocks.restorePost,
}));

import { ContentError } from "@/lib/content/errors";

import * as actions from "./posts";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: null };
const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";

const post = {
  id: POST,
  workspaceId: WS,
  projectId: PROJECT,
  title: "Hello",
  body: "Body",
  status: "draft" as const,
  scheduledFor: "2026-12-01T02:00:00+00:00",
  version: 3,
  lastChangeSource: "user" as const,
  archivedAt: null,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:05:00Z",
  createdBy: USER.id,
  updatedBy: USER.id,
};

const editFields = {
  postId: POST,
  expectedVersion: "3",
  title: "Hello v2",
  body: "New body",
  status: "ready",
  scheduledFor: "",
};

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

const dataFns = [mocks.createPost, mocks.updatePost, mocks.getPost, mocks.archivePost, mocks.restorePost];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
});

describe("module surface", () => {
  it("has no publish or delete action", () => {
    expect(Object.keys(actions).sort()).toEqual([
      "archivePostAction",
      "createPostAction",
      "restorePostAction",
      "setPostStatusAction",
      "updatePostAction",
    ]);
  });
});

describe("signed-out callers", () => {
  it.each([
    ["create", () => actions.createPostAction(null, form({ workspaceId: WS, projectId: PROJECT, title: "x", body: "", status: "draft" }))],
    ["update", () => actions.updatePostAction(null, form(editFields))],
    ["status", () => actions.setPostStatusAction(null, form({ postId: POST, expectedVersion: "3", status: "ready" }))],
    ["archive", () => actions.archivePostAction(null, form({ postId: POST, expectedVersion: "3" }))],
    ["restore", () => actions.restorePostAction(null, form({ postId: POST, expectedVersion: "3" }))],
  ])("%s: requireUser redirects before anything else runs", async (_name, run) => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(run()).rejects.toThrow("NEXT_REDIRECT");
    for (const fn of dataFns) expect(fn).not.toHaveBeenCalled();
  });
});

describe("createPostAction", () => {
  it("creates a post and revalidates the project and post pages", async () => {
    mocks.createPost.mockResolvedValue({ ...post, version: 1 });
    const result = await actions.createPostAction(
      null,
      form({
        workspaceId: WS,
        projectId: PROJECT,
        title: "Hello",
        body: "Body",
        status: "draft",
        scheduledFor: "2026-12-01T09:00:00+07:00",
      }),
    );

    expect(result).toEqual({
      ok: true,
      data: { postId: POST, projectId: PROJECT, workspaceId: WS, version: 1, status: "draft", archived: false },
    });
    expect(mocks.createPost).toHaveBeenCalledWith({
      workspaceId: WS,
      projectId: PROJECT,
      title: "Hello",
      body: "Body",
      status: "draft",
      scheduledFor: "2026-12-01T02:00:00.000Z",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}/p/${PROJECT}`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}/posts/${POST}`);
  });

  it.each([
    ["published status", { status: "published" }],
    ["blank title", { title: "  " }],
    ["schedule without time zone", { scheduledFor: "2026-12-01T09:00" }],
    ["bad project id", { projectId: "nope" }],
  ])("rejects %s without calling the data layer", async (_label, override) => {
    const result = await actions.createPostAction(
      null,
      form({ workspaceId: WS, projectId: PROJECT, title: "Hello", body: "", status: "draft", ...override }),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.createPost).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["version", "created_by", "published_at", "last_change_source"])(
    "rejects the tampered field %s",
    async (key) => {
      const result = await actions.createPostAction(
        null,
        form({ workspaceId: WS, projectId: PROJECT, title: "Hello", body: "", status: "draft", [key]: "1" }),
      );
      expect(result).toMatchObject({ ok: false, fieldErrors: { [key]: "This field cannot be set." } });
      expect(mocks.createPost).not.toHaveBeenCalled();
    },
  );

  it("returns forbidden when RLS rejects the insert", async () => {
    mocks.createPost.mockRejectedValue(new ContentError("forbidden"));
    const result = await actions.createPostAction(
      null,
      form({ workspaceId: WS, projectId: PROJECT, title: "Hello", body: "", status: "draft" }),
    );
    expect(result).toEqual({ ok: false, code: "forbidden", error: "You do not have permission to do this." });
  });
});

describe("updatePostAction", () => {
  it("updates with the expected version and returns the new version", async () => {
    mocks.updatePost.mockResolvedValue({ ...post, version: 4, status: "ready", title: "Hello v2" });
    const result = await actions.updatePostAction(null, form(editFields));

    expect(mocks.updatePost).toHaveBeenCalledWith({
      postId: POST,
      expectedVersion: 3,
      title: "Hello v2",
      body: "New body",
      status: "ready",
      scheduledFor: null,
    });
    expect(result).toMatchObject({ ok: true, data: { version: 4, status: "ready" } });
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(2);
  });

  it("requires expectedVersion", async () => {
    const withoutVersion = form(editFields);
    withoutVersion.delete("expectedVersion");
    const result = await actions.updatePostAction(null, withoutVersion);
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    if (!result.ok) expect(result.fieldErrors?.expectedVersion).toBeDefined();
    expect(mocks.updatePost).not.toHaveBeenCalled();
  });

  it("reports a version conflict and does not revalidate", async () => {
    mocks.updatePost.mockRejectedValue(new ContentError("version_conflict"));
    const result = await actions.updatePostAction(null, form(editFields));
    expect(result).toMatchObject({ ok: false, code: "version_conflict" });
    if (!result.ok) expect(result.error).toMatch(/someone else changed this post/i);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["archived", "not_found", "forbidden"] as const)("passes through %s safely", async (code) => {
    mocks.updatePost.mockRejectedValue(new ContentError(code));
    expect(await actions.updatePostAction(null, form(editFields))).toMatchObject({ ok: false, code });
  });
});

describe("setPostStatusAction", () => {
  it("switches draft to ready keeping the other fields", async () => {
    mocks.getPost.mockResolvedValue(post);
    mocks.updatePost.mockResolvedValue({ ...post, status: "ready", version: 4 });
    const result = await actions.setPostStatusAction(null, form({ postId: POST, expectedVersion: "3", status: "ready" }));

    expect(mocks.updatePost).toHaveBeenCalledWith({
      postId: POST,
      expectedVersion: 3,
      title: "Hello",
      body: "Body",
      status: "ready",
      scheduledFor: post.scheduledFor,
    });
    expect(result).toMatchObject({ ok: true, data: { status: "ready", version: 4 } });
  });

  it("refuses to publish", async () => {
    const result = await actions.setPostStatusAction(null, form({ postId: POST, expectedVersion: "3", status: "published" }));
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.getPost).not.toHaveBeenCalled();
    expect(mocks.updatePost).not.toHaveBeenCalled();
  });

  it("detects a stale version before writing", async () => {
    mocks.getPost.mockResolvedValue({ ...post, version: 5 });
    const result = await actions.setPostStatusAction(null, form({ postId: POST, expectedVersion: "3", status: "ready" }));
    expect(result).toMatchObject({ ok: false, code: "version_conflict" });
    expect(mocks.updatePost).not.toHaveBeenCalled();
  });

  it("still relies on the database check when someone edits in between", async () => {
    mocks.getPost.mockResolvedValue(post);
    mocks.updatePost.mockRejectedValue(new ContentError("version_conflict"));
    const result = await actions.setPostStatusAction(null, form({ postId: POST, expectedVersion: "3", status: "ready" }));
    expect(result).toMatchObject({ ok: false, code: "version_conflict" });
  });

  it("is a no-op when the status is already set", async () => {
    mocks.getPost.mockResolvedValue(post);
    const result = await actions.setPostStatusAction(null, form({ postId: POST, expectedVersion: "3", status: "draft" }));
    expect(result).toMatchObject({ ok: true, data: { version: 3, status: "draft" } });
    expect(mocks.updatePost).not.toHaveBeenCalled();
  });

  it("returns not_found for an invisible post", async () => {
    mocks.getPost.mockResolvedValue(null);
    const result = await actions.setPostStatusAction(null, form({ postId: POST, expectedVersion: "3", status: "ready" }));
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("archivePostAction / restorePostAction", () => {
  it("archives with the expected version", async () => {
    mocks.archivePost.mockResolvedValue({ ...post, version: 4, archivedAt: "2026-11-20T12:00:00Z" });
    const result = await actions.archivePostAction(null, form({ postId: POST, expectedVersion: "3" }));
    expect(mocks.archivePost).toHaveBeenCalledWith({ postId: POST, expectedVersion: 3 });
    expect(result).toMatchObject({ ok: true, data: { archived: true, version: 4 } });
  });

  it("restores with the expected version", async () => {
    mocks.restorePost.mockResolvedValue({ ...post, version: 5 });
    const result = await actions.restorePostAction(null, form({ postId: POST, expectedVersion: "4" }));
    expect(mocks.restorePost).toHaveBeenCalledWith({ postId: POST, expectedVersion: 4 });
    expect(result).toMatchObject({ ok: true, data: { archived: false, version: 5 } });
  });

  it("requires expectedVersion to archive", async () => {
    expect(await actions.archivePostAction(null, form({ postId: POST }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.archivePost).not.toHaveBeenCalled();
  });

  it("reports a version conflict on archive", async () => {
    mocks.archivePost.mockRejectedValue(new ContentError("version_conflict"));
    expect(await actions.archivePostAction(null, form({ postId: POST, expectedVersion: "2" }))).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
  });

  it("reports restoring into an archived project", async () => {
    mocks.restorePost.mockRejectedValue(new ContentError("archived"));
    expect(await actions.restorePostAction(null, form({ postId: POST, expectedVersion: "4" }))).toMatchObject({
      ok: false,
      code: "archived",
    });
  });
});
