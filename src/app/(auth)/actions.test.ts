import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  signUp: vi.fn(),
  upsert: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/site-url", () => ({ getSiteOrigin: async () => "http://localhost:3000" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { signUp: mocks.signUp },
    from: (table: string) => ({ upsert: (row: unknown, opts: unknown) => mocks.upsert(table, row, opts) }),
  }),
}));

import { signUp } from "./actions";

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}
const creds = { email: "an@example.test", password: "password-123" };
const session = { data: { session: { access_token: "x" }, user: { id: "u" } }, error: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsert.mockResolvedValue({ error: null });
});

describe("signUp with an optional display name", () => {
  it("without a name: no metadata, no profile write", async () => {
    mocks.signUp.mockResolvedValue(session);
    await expect(signUp({}, form({ ...creds, displayName: "  " }))).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(mocks.signUp.mock.calls[0]![0].options).not.toHaveProperty("data");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("with a name and a session: saves the profile (name only, never the email)", async () => {
    mocks.signUp.mockResolvedValue(session);
    await expect(signUp({}, form({ ...creds, displayName: " Nguyễn An " }))).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(mocks.signUp.mock.calls[0]![0].options.data).toEqual({ display_name: "Nguyễn An" });
    expect(mocks.upsert).toHaveBeenCalledWith("user_profiles", { display_name: "Nguyễn An" }, { onConflict: "user_id" });
  });

  it("a failed profile write never blocks sign-up", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.signUp.mockResolvedValue(session);
    mocks.upsert.mockResolvedValue({ error: { code: "42501", message: "secret" } });
    await expect(signUp({}, form({ ...creds, displayName: "An" }))).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|an@example/);
    log.mockRestore();
  });

  it("email confirmation on (no session): keeps the name in metadata only", async () => {
    mocks.signUp.mockResolvedValue({ data: { session: null, user: { id: "u" } }, error: null });
    const result = await signUp({}, form({ ...creds, displayName: "An" }));
    expect(result.message).toMatch(/xác nhận/);
    expect(mocks.signUp.mock.calls[0]![0].options.data).toEqual({ display_name: "An" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("an invalid name is a field error and nothing is created", async () => {
    const result = await signUp({}, form({ ...creds, displayName: "x".repeat(61) }));
    expect(result.fieldErrors?.displayName).toBe("Tên hiển thị tối đa 60 ký tự.");
    expect(result.values?.displayName).toBe("x".repeat(61));
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it("credential errors and name errors are reported together", async () => {
    const result = await signUp({}, form({ email: "bad", password: "short", displayName: "A\nB" }));
    expect(Object.keys(result.fieldErrors ?? {}).sort()).toEqual(["displayName", "email", "password"]);
  });
});
