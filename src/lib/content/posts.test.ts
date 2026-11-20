import { beforeEach, describe, expect, it, vi } from "vitest";

import { dbError, fakeSupabase, ok, type FakeResult } from "./__tests__/fake-supabase";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), getCurrentUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth/dal", () => ({ getCurrentUser: mocks.getCurrentUser }));

import { ContentError } from "./errors";
import * as posts from "./posts";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";

const postRow = {
  id: POST,
  workspace_id: WS,
  project_id: PROJECT,
  title: "Hello",
  body: "Body",
  status: "draft",
  scheduled_for: null,
  published_at: null,
  version: 3,
  last_change_source: "user",
  created_by: USER,
  updated_by: USER,
  archived_at: null,
  created_at: "2026-11-20T10:00:00Z",
  updated_at: "2026-11-20T10:05:00Z",
};

const edit = { title: "Hello v2", body: "New body", status: "ready", scheduledFor: "2026-12-01T09:00:00+07:00" };

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
  mocks.getCurrentUser.mockResolvedValue({ id: USER, email: null });
});

describe("module surface", () => {
  it("exposes no delete or publish operation", () => {
    expect(Object.keys(posts).sort()).toEqual([
      "archivePost",
      "createPost",
      "getPost",
      "getPostHistory",
      "listPosts",
      "restorePost",
      "setPostStatus",
      "updatePost",
    ]);
  });
});

describe("reads", () => {
  it("lists active posts of a project without bodies", async () => {
    const fake = setup([ok([postRow])]);
    const result = await posts.listPosts({ projectId: PROJECT, status: "draft" });

    const query = fake.queries[0]!;
    expect(query.table).toBe("content_posts");
    expect(String(query.args("select")?.[0])).not.toMatch(/\bbody\b/);
    expect(query.calls).toContainEqual(["eq", ["project_id", PROJECT]]);
    expect(query.calls).toContainEqual(["eq", ["status", "draft"]]);
    expect(query.calls).toContainEqual(["is", ["archived_at", null]]);
    expect(result[0]).toMatchObject({ id: POST, projectId: PROJECT, version: 3, lastChangeSource: "user" });
    expect(result[0]).not.toHaveProperty("publishedAt");
  });

  it("rejects a published filter before querying", async () => {
    await expectContentError(posts.listPosts({ projectId: PROJECT, status: "published" }), "invalid_input");
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("returns null for an invisible post", async () => {
    setup([ok(null)]);
    expect(await posts.getPost({ postId: POST })).toBeNull();
  });

  it("returns a post with its body", async () => {
    setup([ok(postRow)]);
    expect(await posts.getPost({ postId: POST })).toMatchObject({ body: "Body", createdBy: USER, version: 3 });
  });

  it("reads the history newest first", async () => {
    const fake = setup([
      ok([
        {
          id: "v3",
          post_id: POST,
          version: 3,
          title: "Hello",
          body: "Body",
          status: "draft",
          scheduled_for: null,
          archived_at: null,
          changed_by: USER,
          change_source: "user",
          created_at: "2026-11-20T10:05:00Z",
        },
      ]),
    ]);
    const history = await posts.getPostHistory({ postId: POST });

    const query = fake.queries[0]!;
    expect(query.table).toBe("content_post_versions");
    expect(query.calls).toContainEqual(["eq", ["post_id", POST]]);
    expect(query.calls).toContainEqual(["order", ["version", { ascending: false }]]);
    expect(history[0]).toMatchObject({ version: 3, changedBy: USER, changeSource: "user" });
  });
});

describe("createPost", () => {
  it("inserts only allowed columns, marks the change as a user change and normalises the schedule", async () => {
    const fake = setup([ok(postRow)]);
    await posts.createPost({ workspaceId: WS, projectId: PROJECT, ...edit });

    const [payload] = fake.queries[0]!.args("insert") as [Record<string, unknown>];
    expect(Object.keys(payload).sort()).toEqual([
      "body",
      "id",
      "last_change_source",
      "project_id",
      "scheduled_for",
      "status",
      "title",
      "workspace_id",
    ]);
    expect(payload).toMatchObject({
      last_change_source: "user",
      status: "ready",
      scheduled_for: "2026-12-01T02:00:00.000Z",
    });
  });

  it.each(["version", "created_by", "updated_by", "published_at", "archived_at", "last_change_source", "changeSource"])(
    "rejects the forbidden field %s without touching the database",
    async (key) => {
      const error = await expectContentError(
        posts.createPost({ workspaceId: WS, projectId: PROJECT, ...edit, [key]: key === "version" ? 1 : "agent" }),
        "invalid_input",
      );
      expect(error.fieldErrors?.[key]).toBe("Không được phép gửi trường này.");
      expect(mocks.createClient).not.toHaveBeenCalled();
    },
  );

  it("rejects publishing", async () => {
    await expectContentError(
      posts.createPost({ workspaceId: WS, projectId: PROJECT, ...edit, status: "published" }),
      "invalid_input",
    );
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("maps an RLS rejection (foreign workspace or archived project) to forbidden", async () => {
    setup([dbError("42501", 'new row violates row-level security policy for table "content_posts"')]);
    const error = await expectContentError(posts.createPost({ workspaceId: WS, projectId: PROJECT, ...edit }), "forbidden");
    expect(error.message).not.toMatch(/content_posts|row-level/);
  });
});

describe("updatePost", () => {
  it("calls update_content_post with the expected version and change source 'user'", async () => {
    const fake = setup([ok({ ...postRow, version: 4, title: "Hello v2" })]);
    const result = await posts.updatePost({ postId: POST, expectedVersion: "3", ...edit });

    expect(fake.queries).toHaveLength(0);
    expect(fake.rpcs).toEqual([
      {
        fn: "update_content_post",
        args: {
          p_post_id: POST,
          p_expected_version: 3,
          p_title: "Hello v2",
          p_body: "New body",
          p_status: "ready",
          p_scheduled_for: "2026-12-01T02:00:00.000Z",
          p_change_source: "user",
        },
      },
    ]);
    expect(result).toMatchObject({ version: 4, title: "Hello v2" });
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["not a number", "latest"],
  ])("requires an expected version (%s)", async (_label, expectedVersion) => {
    const error = await expectContentError(posts.updatePost({ postId: POST, expectedVersion, ...edit }), "invalid_input");
    expect(error.fieldErrors?.expectedVersion).toBeDefined();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("does not let the caller choose the version or the change source", async () => {
    await expectContentError(
      posts.updatePost({ postId: POST, expectedVersion: 3, ...edit, version: 99, changeSource: "agent" }),
      "invalid_input",
    );
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each([
    ["CP409", "version_conflict"],
    ["CP423", "archived"],
    ["CP404", "not_found"],
    ["42501", "forbidden"],
    ["23514", "invalid_input"],
  ] as const)("maps RPC error %s to %s", async (sqlstate, code) => {
    setup([dbError(sqlstate, "Content post was changed by someone else")]);
    await expectContentError(posts.updatePost({ postId: POST, expectedVersion: 3, ...edit }), code);
  });

  it("treats an empty RPC result as an unknown error", async () => {
    setup([ok(null)]);
    await expectContentError(posts.updatePost({ postId: POST, expectedVersion: 3, ...edit }), "unknown");
  });
});

describe("archivePost / restorePost", () => {
  it("archives through the RPC with the expected version", async () => {
    const fake = setup([ok({ ...postRow, version: 4, archived_at: "2026-11-20T12:00:00Z" })]);
    const result = await posts.archivePost({ postId: POST, expectedVersion: 3 });
    expect(fake.rpcs).toEqual([
      { fn: "archive_content_post", args: { p_post_id: POST, p_expected_version: 3, p_change_source: "user" } },
    ]);
    expect(result.archivedAt).toBe("2026-11-20T12:00:00Z");
  });

  it("restores through the RPC with the expected version", async () => {
    const fake = setup([ok({ ...postRow, version: 5 })]);
    await posts.restorePost({ postId: POST, expectedVersion: 4 });
    expect(fake.rpcs[0]).toEqual({
      fn: "restore_content_post",
      args: { p_post_id: POST, p_expected_version: 4, p_change_source: "user" },
    });
  });

  it("requires an expected version to archive", async () => {
    await expectContentError(posts.archivePost({ postId: POST }), "invalid_input");
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("reports a stale archive as a version conflict", async () => {
    setup([dbError("CP409")]);
    await expectContentError(posts.archivePost({ postId: POST, expectedVersion: 2 }), "version_conflict");
  });

  it("reports restoring into an archived project as archived", async () => {
    setup([dbError("CP423")]);
    await expectContentError(posts.restorePost({ postId: POST, expectedVersion: 4 }), "archived");
  });
});

describe("setPostStatus (regression: switching status must not change other fields)", () => {
  // Values that validation would normalise: surrounding spaces in the title
  // (trim), a tab-only title (rejected after trim, but valid in the database),
  // whitespace around the body, and microsecond precision in scheduled_for.
  const raw = {
    ...postRow,
    title: "  Hello world  ",
    body: "\n  indented body\n\n",
    scheduled_for: "2026-12-01T02:00:00.123456+00:00",
    status: "draft",
    version: 3,
  };

  it("sends title, body and scheduled_for back to the RPC byte for byte", async () => {
    const fake = setup([ok(raw), ok({ ...raw, status: "ready", version: 4 })]);
    const result = await posts.setPostStatus({ postId: POST, expectedVersion: 3, status: "ready" });

    expect(fake.queries[0]!.table).toBe("content_posts");
    expect(fake.queries[0]!.calls).toContainEqual(["eq", ["id", POST]]);
    expect(fake.rpcs).toEqual([
      {
        fn: "update_content_post",
        args: {
          p_post_id: POST,
          p_expected_version: 3,
          p_title: "  Hello world  ",
          p_body: "\n  indented body\n\n",
          p_status: "ready",
          p_scheduled_for: "2026-12-01T02:00:00.123456+00:00",
          p_change_source: "user",
        },
      },
    ]);
    expect(result).toMatchObject({
      title: "  Hello world  ",
      body: "\n  indented body\n\n",
      scheduledFor: "2026-12-01T02:00:00.123456+00:00",
      status: "ready",
      version: 4,
    });
  });

  it("works for a title that is valid in the database but would fail re-validation", async () => {
    const fake = setup([ok({ ...raw, title: "\t" }), ok({ ...raw, title: "\t", status: "ready", version: 4 })]);
    await posts.setPostStatus({ postId: POST, expectedVersion: 3, status: "ready" });
    expect(fake.rpcs[0]!.args.p_title).toBe("\t");
  });

  it("keeps a null schedule null and switches ready back to draft", async () => {
    const fake = setup([
      ok({ ...raw, status: "ready", scheduled_for: null }),
      ok({ ...raw, status: "draft", scheduled_for: null, version: 4 }),
    ]);
    await posts.setPostStatus({ postId: POST, expectedVersion: 3, status: "draft" });
    expect(fake.rpcs[0]!.args).toMatchObject({ p_status: "draft", p_scheduled_for: null });
  });

  it("does not call the RPC when the status is already set", async () => {
    const fake = setup([ok(raw)]);
    const result = await posts.setPostStatus({ postId: POST, expectedVersion: 3, status: "draft" });
    expect(fake.rpcs).toHaveLength(0);
    expect(result.version).toBe(3);
  });

  it("reports a stale expected version without writing", async () => {
    const fake = setup([ok({ ...raw, version: 5 })]);
    await expectContentError(posts.setPostStatus({ postId: POST, expectedVersion: 3, status: "ready" }), "version_conflict");
    expect(fake.rpcs).toHaveLength(0);
  });

  it("relies on the RPC version check when the post changes between read and write", async () => {
    setup([ok(raw), dbError("CP409")]);
    await expectContentError(posts.setPostStatus({ postId: POST, expectedVersion: 3, status: "ready" }), "version_conflict");
  });

  it("returns not_found for an invisible post", async () => {
    const fake = setup([ok(null)]);
    await expectContentError(posts.setPostStatus({ postId: POST, expectedVersion: 3, status: "ready" }), "not_found");
    expect(fake.rpcs).toHaveLength(0);
  });

  it("maps an archived post to archived", async () => {
    setup([ok(raw), dbError("CP423")]);
    await expectContentError(posts.setPostStatus({ postId: POST, expectedVersion: 3, status: "ready" }), "archived");
  });

  it.each([
    ["published", { postId: POST, expectedVersion: 3, status: "published" }],
    ["missing version", { postId: POST, status: "ready" }],
    ["extra title field", { postId: POST, expectedVersion: 3, status: "ready", title: "x" }],
    ["extra version field", { postId: POST, expectedVersion: 3, status: "ready", version: 9 }],
  ])("rejects %s before touching the database", async (_label, input) => {
    await expectContentError(posts.setPostStatus(input), "invalid_input");
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
