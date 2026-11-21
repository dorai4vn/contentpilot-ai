import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), revalidatePath: vi.fn(), updateMyDisplayName: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/dal", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/profiles/profiles", () => ({ updateMyDisplayName: mocks.updateMyDisplayName }));

import { ContentError } from "@/lib/content/errors";

import { updateDisplayNameAction } from "./profile";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: null };
function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
});

describe("updateDisplayNameAction", () => {
  it("signed out: redirected before anything runs", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(updateDisplayNameAction(null, form({ displayName: "An" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.updateMyDisplayName).not.toHaveBeenCalled();
  });

  it("saves the trimmed name and revalidates account and workspace pages", async () => {
    mocks.updateMyDisplayName.mockResolvedValue({ displayName: "An", updatedAt: "2026-11-21T00:00:00Z" });
    const result = await updateDisplayNameAction(null, form({ displayName: "  An " }));
    expect(result).toEqual({ ok: true, data: { displayName: "An", updatedAt: "2026-11-21T00:00:00Z" } });
    expect(mocks.updateMyDisplayName).toHaveBeenCalledWith({ displayName: "An" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/account");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/w/[workspaceId]", "layout");
  });

  it.each(["userId", "user_id", "role", "email"])("rejects the forged field %s", async (key) => {
    const result = await updateDisplayNameAction(null, form({ displayName: "An", [key]: "x" }));
    expect(result).toMatchObject({ ok: false, code: "invalid_input", fieldErrors: { [key]: "Không được phép gửi trường này." } });
    expect(mocks.updateMyDisplayName).not.toHaveBeenCalled();
  });

  it("returns Vietnamese field errors", async () => {
    const result = await updateDisplayNameAction(null, form({ displayName: "x".repeat(61) }));
    expect(result).toMatchObject({ ok: false, fieldErrors: { displayName: "Tên hiển thị tối đa 60 ký tự." } });
  });

  it("maps data-layer errors", async () => {
    mocks.updateMyDisplayName.mockRejectedValue(new ContentError("forbidden"));
    expect(await updateDisplayNameAction(null, form({ displayName: "An" }))).toMatchObject({ ok: false, code: "forbidden" });
  });
});
