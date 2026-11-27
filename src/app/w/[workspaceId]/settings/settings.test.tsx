import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadWorkspace: vi.fn(), renameWorkspace: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../../_lib/load", () => ({ loadWorkspace: mocks.loadWorkspace }));
vi.mock("@/lib/workspaces/queries", () => ({ renameWorkspace: mocks.renameWorkspace }));

import { contentPermissions } from "@/lib/content/permissions";

import { renameWorkspaceAction } from "./actions";
import { RenameWorkspaceForm } from "./rename-workspace-form";

const WS = "22222222-2222-4222-8222-222222222222";
const form = (name: unknown) => { const f = new FormData(); if (name !== undefined) f.set("name", name as string); return f; };
const as = (role: "owner" | "admin" | "member") =>
  mocks.loadWorkspace.mockResolvedValue({ workspace: { id: WS, name: "Cũ", role }, permissions: contentPermissions(role) });

beforeEach(() => { vi.clearAllMocks(); mocks.renameWorkspace.mockResolvedValue(undefined); });

describe("renameWorkspaceAction", () => {
  it.each(["owner", "admin"] as const)("lets %s rename, trimmed, and revalidates", async (role) => {
    as(role);
    const res = await renameWorkspaceAction(WS, {}, form("  Tên mới  "));
    expect(res).toEqual({ ok: true, name: "Tên mới" });
    expect(mocks.renameWorkspace).toHaveBeenCalledWith(WS, "Tên mới");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/${WS}`, "layout");
  });

  it("denies members without touching the database", async () => {
    as("member");
    const res = await renameWorkspaceAction(WS, {}, form("Tên mới"));
    expect(res.error).toMatch(/không có quyền/);
    expect(mocks.renameWorkspace).not.toHaveBeenCalled();
  });

  it("propagates notFound for outsiders / cross-workspace ids", async () => {
    mocks.loadWorkspace.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(renameWorkspaceAction(WS, {}, form("x"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.renameWorkspace).not.toHaveBeenCalled();
  });

  it.each([["empty", ""], ["blank", "   "], ["missing", undefined], ["too long", "a".repeat(101)]])("rejects %s names", async (_l, v) => {
    as("owner");
    const res = await renameWorkspaceAction(WS, {}, form(v));
    expect(res.error).toBeTruthy();
    expect(mocks.renameWorkspace).not.toHaveBeenCalled();
  });

  it("accepts exactly 100 characters", async () => {
    as("owner");
    expect((await renameWorkspaceAction(WS, {}, form("a".repeat(100)))).ok).toBe(true);
  });

  it("returns a generic error when the update fails (e.g. RLS)", async () => {
    as("admin");
    mocks.renameWorkspace.mockRejectedValue(new Error("secret db detail"));
    const res = await renameWorkspaceAction(WS, {}, form("Ok"));
    expect(res.error).toBe("Không thể đổi tên không gian làm việc. Vui lòng thử lại.");
    expect(res.ok).toBeUndefined();
  });
});

describe("RenameWorkspaceForm", () => {
  it("shows the current name and an Edit button for managers", () => {
    const html = renderToStaticMarkup(<RenameWorkspaceForm workspaceId={WS} currentName="Tin thể thao" canEdit />);
    expect(html).toContain("Tin thể thao");
    expect(html).toContain(">Sửa<");
  });

  it("is read-only for members", () => {
    const html = renderToStaticMarkup(<RenameWorkspaceForm workspaceId={WS} currentName="Tin thể thao" canEdit={false} />);
    expect(html).toContain("Tin thể thao");
    expect(html).not.toContain(">Sửa<");
    expect(html).toContain("Chỉ Chủ sở hữu");
  });
});
