import { beforeEach, describe, expect, it, vi } from "vitest";

import { dbError, fakeSupabase, ok, type FakeResult } from "./__tests__/fake-supabase";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), getCurrentUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth/dal", () => ({ getCurrentUser: mocks.getCurrentUser }));

import { ContentError } from "./errors";
import * as projects from "./projects";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

const row = {
  id: PROJECT,
  workspace_id: WS,
  name: "Blog",
  description: null,
  created_by: USER,
  archived_at: null,
  created_at: "2026-11-20T10:00:00Z",
  updated_at: "2026-11-20T10:00:00Z",
};

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
    expect(Object.keys(projects).sort()).toEqual([
      "archiveProject",
      "createProject",
      "getProject",
      "listProjects",
      "restoreProject",
      "updateProject",
    ]);
  });
});

describe("authentication and validation happen before any database call", () => {
  it("rejects a signed-out caller", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    await expectContentError(projects.listProjects({ workspaceId: WS }), "unauthenticated");
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("rejects an invalid workspace id", async () => {
    const error = await expectContentError(projects.listProjects({ workspaceId: "nope" }), "invalid_input");
    expect(error.fieldErrors?.workspaceId).toBeDefined();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each(["created_by", "archived_at", "workspace_id", "id"])("rejects the forbidden field %s on create", async (key) => {
    const error = await expectContentError(
      projects.createProject({ workspaceId: WS, name: "Blog", [key]: USER }),
      "invalid_input",
    );
    expect(error.fieldErrors?.[key]).toBe("This field cannot be set.");
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

describe("listProjects", () => {
  it("reads active projects of the workspace as the user", async () => {
    const fake = setup([ok([row])]);
    const result = await projects.listProjects({ workspaceId: WS });

    const query = fake.queries[0]!;
    expect(query.table).toBe("content_projects");
    expect(query.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(query.calls).toContainEqual(["is", ["archived_at", null]]);
    expect(query.methods()).toContain("limit");
    expect(result).toEqual([
      {
        id: PROJECT,
        workspaceId: WS,
        name: "Blog",
        description: null,
        createdBy: USER,
        archivedAt: null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    ]);
  });

  it("includes archived projects on request", async () => {
    const fake = setup([ok([])]);
    await projects.listProjects({ workspaceId: WS, includeArchived: true });
    expect(fake.queries[0]!.methods()).not.toContain("is");
  });

  it("hides database error details", async () => {
    setup([dbError("XX000", "relation secret_table does not exist")]);
    const error = await expectContentError(projects.listProjects({ workspaceId: WS }), "unknown");
    expect(error.message).not.toMatch(/secret/);
  });
});

describe("getProject", () => {
  it("returns null when the project is not visible", async () => {
    setup([ok(null)]);
    expect(await projects.getProject({ projectId: PROJECT })).toBeNull();
  });
});

describe("createProject", () => {
  it("inserts only the allowed columns with a fresh uuid", async () => {
    const fake = setup([ok(row)]);
    await projects.createProject({ workspaceId: WS, name: "  Blog ", description: "" });

    const [payload] = fake.queries[0]!.args("insert") as [Record<string, unknown>];
    expect(Object.keys(payload).sort()).toEqual(["description", "id", "name", "workspace_id"]);
    expect(payload).toMatchObject({ workspace_id: WS, name: "Blog", description: null });
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps an RLS rejection (plain member) to forbidden", async () => {
    setup([dbError("42501", 'new row violates row-level security policy for table "content_projects"')]);
    const error = await expectContentError(projects.createProject({ workspaceId: WS, name: "Blog" }), "forbidden");
    expect(error.message).not.toMatch(/row-level|content_projects/);
  });
});

describe("updateProject", () => {
  it("updates only name and description of an active project", async () => {
    const fake = setup([ok({ ...row, name: "News" })]);
    const result = await projects.updateProject({ projectId: PROJECT, name: "News", description: "Daily" });

    const query = fake.queries[0]!;
    expect(query.args("update")).toEqual([{ name: "News", description: "Daily" }]);
    expect(query.calls).toContainEqual(["eq", ["id", PROJECT]]);
    expect(query.calls).toContainEqual(["is", ["archived_at", null]]);
    expect(result.name).toBe("News");
  });

  it.each([
    ["not_found", null],
    ["archived", { archived_at: "2026-11-20T11:00:00Z" }],
    ["forbidden", { archived_at: null }],
  ] as const)("explains a silent no-op update as %s", async (code, lookup) => {
    const fake = setup([ok(null), ok(lookup)]);
    await expectContentError(projects.updateProject({ projectId: PROJECT, name: "News" }), code);
    expect(fake.remaining()).toBe(0);
  });
});

describe("archiveProject / restoreProject", () => {
  it("archives by setting archived_at (the database stamps the time)", async () => {
    const fake = setup([ok({ ...row, archived_at: "2026-11-20T12:00:00Z" })]);
    const result = await projects.archiveProject({ projectId: PROJECT });
    const [payload] = fake.queries[0]!.args("update") as [{ archived_at: string }];
    expect(Object.keys(payload)).toEqual(["archived_at"]);
    expect(typeof payload.archived_at).toBe("string");
    expect(result.archivedAt).toBe("2026-11-20T12:00:00Z");
  });

  it("restores by clearing archived_at", async () => {
    const fake = setup([ok(row)]);
    await projects.restoreProject({ projectId: PROJECT });
    expect(fake.queries[0]!.args("update")).toEqual([{ archived_at: null }]);
  });

  it("reports a member's attempt as forbidden", async () => {
    setup([ok(null), ok({ archived_at: null })]);
    await expectContentError(projects.archiveProject({ projectId: PROJECT }), "forbidden");
  });
});
