import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  revalidatePath: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  archiveProject: vi.fn(),
  restoreProject: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/dal", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/content/projects", () => ({
  createProject: mocks.createProject,
  updateProject: mocks.updateProject,
  archiveProject: mocks.archiveProject,
  restoreProject: mocks.restoreProject,
}));

import { ContentError } from "@/lib/content/errors";

import {
  archiveProjectAction,
  createProjectAction,
  restoreProjectAction,
  updateProjectAction,
} from "./projects";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: null };
const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

const project = {
  id: PROJECT,
  workspaceId: WS,
  name: "Blog",
  description: null,
  createdBy: USER.id,
  archivedAt: null,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:00:00Z",
};

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

const dataFns = [mocks.createProject, mocks.updateProject, mocks.archiveProject, mocks.restoreProject];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
});

describe("signed-out callers", () => {
  it.each([
    ["create", () => createProjectAction(null, form({ workspaceId: WS, name: "Blog" }))],
    ["update", () => updateProjectAction(null, form({ projectId: PROJECT, name: "Blog" }))],
    ["archive", () => archiveProjectAction(null, form({ projectId: PROJECT }))],
    ["restore", () => restoreProjectAction(null, form({ projectId: PROJECT }))],
  ])("%s: requireUser redirects before anything else runs", async (_name, run) => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(run()).rejects.toThrow("NEXT_REDIRECT");
    for (const fn of dataFns) expect(fn).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createProjectAction", () => {
  it("creates the project and revalidates its pages", async () => {
    mocks.createProject.mockResolvedValue(project);
    const result = await createProjectAction(
      null,
      form({ workspaceId: WS, name: "  Blog ", description: "", $ACTION_ID_abc: "" }),
    );

    expect(result).toEqual({ ok: true, data: { projectId: PROJECT, workspaceId: WS, archived: false } });
    expect(mocks.createProject).toHaveBeenCalledWith({ workspaceId: WS, name: "Blog", description: null });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}/p/${PROJECT}`);
  });

  it("returns field errors for invalid input without calling the data layer", async () => {
    const result = await createProjectAction(null, form({ workspaceId: "nope", name: "" }));
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    if (!result.ok) {
      expect(result.fieldErrors?.workspaceId).toBeDefined();
      expect(result.fieldErrors?.name).toMatch(/Vui lòng nhập/);
    }
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["created_by", "archived_at", "id"])("rejects the tampered field %s", async (key) => {
    const result = await createProjectAction(null, form({ workspaceId: WS, name: "Blog", [key]: "x" }));
    expect(result).toMatchObject({ ok: false, code: "invalid_input", fieldErrors: { [key]: "Không được phép gửi trường này." } });
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("rejects repeated fields and files", async () => {
    const repeated = form({ workspaceId: WS, name: "Blog" });
    repeated.append("name", "Other");
    expect(await createProjectAction(null, repeated)).toMatchObject({ ok: false, code: "invalid_input" });

    const withFile = form({ workspaceId: WS });
    withFile.append("name", new Blob(["x"]), "x.txt");
    expect(await createProjectAction(null, withFile)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("returns a safe forbidden error for a plain member", async () => {
    mocks.createProject.mockRejectedValue(new ContentError("forbidden"));
    const result = await createProjectAction(null, form({ workspaceId: WS, name: "Blog" }));
    expect(result).toEqual({ ok: false, code: "forbidden", error: "Bạn không có quyền thực hiện thao tác này." });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("hides unexpected errors behind a generic message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createProject.mockRejectedValue(new Error('relation "secret_table" does not exist'));
    const result = await createProjectAction(null, form({ workspaceId: WS, name: "Blog" }));
    expect(result).toEqual({ ok: false, code: "unknown", error: "Đã có lỗi xảy ra. Vui lòng thử lại." });
    expect(JSON.stringify(result)).not.toMatch(/secret/);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("logs only the error class and code, never the message, details, stack or content", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbError = Object.assign(
      new Error("null value violates not-null constraint. Failing row contains (Bí mật nội dung, sk-proj-LEAK0000)"),
      { code: "XX000", details: "Failing row contains (Bí mật nội dung)", hint: "secret hint" },
    );
    mocks.createProject.mockRejectedValue(dbError);

    const result = await createProjectAction(null, form({ workspaceId: WS, name: "Blog" }));

    // Unchanged behaviour for the user.
    expect(result).toEqual({ ok: false, code: "unknown", error: "Đã có lỗi xảy ra. Vui lòng thử lại." });
    // Safe log line.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[content action]", '{"event":"unexpected_error","type":"Error","code":"XX000"}');
    const logged = JSON.stringify(log.mock.calls);
    for (const leak of ["Bí mật", "sk-proj", "Failing row", "secret hint", "not-null", " at "]) {
      expect(logged).not.toContain(leak);
    }
    log.mockRestore();
  });

  it("expected (mapped) errors are not logged at all", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createProject.mockRejectedValue(new ContentError("forbidden"));
    await createProjectAction(null, form({ workspaceId: WS, name: "Blog" }));
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("updateProjectAction", () => {
  it("updates name and description", async () => {
    mocks.updateProject.mockResolvedValue({ ...project, name: "News" });
    const result = await updateProjectAction(null, form({ projectId: PROJECT, name: "News", description: "Daily" }));
    expect(result.ok).toBe(true);
    expect(mocks.updateProject).toHaveBeenCalledWith({ projectId: PROJECT, name: "News", description: "Daily" });
  });

  it("reports an archived project", async () => {
    mocks.updateProject.mockRejectedValue(new ContentError("archived"));
    const result = await updateProjectAction(null, form({ projectId: PROJECT, name: "News" }));
    expect(result).toMatchObject({ ok: false, code: "archived" });
  });
});

describe("archiveProjectAction / restoreProjectAction", () => {
  it("archives and revalidates", async () => {
    mocks.archiveProject.mockResolvedValue({ ...project, archivedAt: "2026-11-20T12:00:00Z" });
    const result = await archiveProjectAction(null, form({ projectId: PROJECT }));
    expect(result).toEqual({ ok: true, data: { projectId: PROJECT, workspaceId: WS, archived: true } });
    expect(mocks.archiveProject).toHaveBeenCalledWith({ projectId: PROJECT });
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(2);
  });

  it("restores", async () => {
    mocks.restoreProject.mockResolvedValue(project);
    const result = await restoreProjectAction(null, form({ projectId: PROJECT }));
    expect(result).toMatchObject({ ok: true, data: { archived: false } });
  });

  it("returns forbidden when a member tries to archive", async () => {
    mocks.archiveProject.mockRejectedValue(new ContentError("forbidden"));
    expect(await archiveProjectAction(null, form({ projectId: PROJECT }))).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("rejects an invalid project id", async () => {
    expect(await restoreProjectAction(null, form({ projectId: "x" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.restoreProject).not.toHaveBeenCalled();
  });
});
