import { beforeEach, describe, expect, it, vi } from "vitest";

import { dbError, fakeSupabase, ok, type FakeResult } from "@/lib/content/__tests__/fake-supabase";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), getCurrentUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth/dal", () => ({ getCurrentUser: mocks.getCurrentUser }));

import { ContentError } from "@/lib/content/errors";

import * as profiles from "./profiles";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "55555555-5555-4555-8555-555555555555";

function setup(results: FakeResult[], user: unknown = null) {
  const fake = fakeSupabase(results);
  const client = { ...fake.client, auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) } };
  mocks.createClient.mockResolvedValue(client);
  return { ...fake, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUser.mockResolvedValue({ id: USER, email: null });
});

describe("getMyProfile", () => {
  it("reads the session user's own row", async () => {
    const fake = setup([ok({ display_name: "An", updated_at: "2026-11-21T00:00:00Z" })]);
    expect(await profiles.getMyProfile()).toEqual({ displayName: "An", updatedAt: "2026-11-21T00:00:00Z" });
    expect(fake.queries[0]!.table).toBe("user_profiles");
    expect(fake.queries[0]!.calls).toContainEqual(["eq", ["user_id", USER]]);
    expect(fake.queries[0]!.args("select")?.[0]).not.toMatch(/email/);
  });

  it("returns null when the user has no profile yet", async () => {
    setup([ok(null)]);
    expect(await profiles.getMyProfile()).toBeNull();
  });

  it("requires a session", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    await expect(profiles.getMyProfile()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

describe("updateMyDisplayName", () => {
  it("upserts only the display name (no user id: the database takes it from the session)", async () => {
    const fake = setup([ok({ display_name: "Nguyễn An", updated_at: "2026-11-21T00:00:00Z" })]);
    const result = await profiles.updateMyDisplayName({ displayName: "  Nguyễn   An " });
    expect(result.displayName).toBe("Nguyễn An");
    const query = fake.queries[0]!;
    expect(query.args("upsert")).toEqual([{ display_name: "Nguyễn An" }, { onConflict: "user_id" }]);
  });

  it.each(["userId", "user_id", "role", "email"])("rejects the forged field %s before any query", async (key) => {
    const fake = setup([]);
    await expect(profiles.updateMyDisplayName({ displayName: "An", [key]: OTHER })).rejects.toMatchObject({
      code: "invalid_input",
      fieldErrors: { [key]: "Không được phép gửi trường này." },
    });
    expect(fake.queries).toHaveLength(0);
  });

  it.each([{ displayName: "" }, { displayName: "x".repeat(61) }, { displayName: "A\nB" }, {}])("rejects invalid input %j", async (input) => {
    const fake = setup([]);
    await expect(profiles.updateMyDisplayName(input)).rejects.toBeInstanceOf(ContentError);
    expect(fake.queries).toHaveLength(0);
  });

  it("maps database errors to safe codes", async () => {
    setup([dbError("42501")]);
    await expect(profiles.updateMyDisplayName({ displayName: "An" })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("listDisplayNames", () => {
  it("reads visible names of the given users (deduplicated), keyed by id", async () => {
    const fake = setup([ok([{ user_id: OTHER, display_name: "Bình" }])]);
    const names = await profiles.listDisplayNames([OTHER, OTHER, USER]);
    expect(fake.queries[0]!.calls).toContainEqual(["in", ["user_id", [OTHER, USER]]]);
    expect(fake.queries[0]!.args("select")?.[0]).toBe("user_id, display_name");
    expect(names.get(OTHER)).toBe("Bình");
    expect(names.has(USER)).toBe(false);
  });

  it("makes no query for an empty list and rejects malformed ids", async () => {
    const fake = setup([]);
    expect((await profiles.listDisplayNames([])).size).toBe(0);
    await expect(profiles.listDisplayNames(["nope"])).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.queries).toHaveLength(0);
  });
});

describe("sign-up helpers", () => {
  it("saveSignupDisplayName upserts a valid name and reports failures without throwing", async () => {
    const fake = fakeSupabase([ok(null), dbError("42501")]);
    const client = fake.client as never;
    expect(await profiles.saveSignupDisplayName(client, " An ")).toBe(true);
    expect(fake.queries[0]!.args("upsert")).toEqual([{ display_name: "An" }, { onConflict: "user_id" }]);
    expect(await profiles.saveSignupDisplayName(client, "An")).toBe(false);
    expect(await profiles.saveSignupDisplayName(client, "x".repeat(61))).toBe(false);
    expect(fake.queries).toHaveLength(2);
  });

  it("ensureProfileFromSignup creates the profile from metadata only when missing", async () => {
    const fake = setup([ok(null), ok(null)], { id: USER, user_metadata: { display_name: "An" } });
    await profiles.ensureProfileFromSignup(fake.client as never);
    expect(fake.queries.map((q) => q.methods()[0])).toEqual(["select", "upsert"]);

    const existing = setup([ok({ user_id: USER })], { id: USER, user_metadata: { display_name: "An" } });
    await profiles.ensureProfileFromSignup(existing.client as never);
    expect(existing.queries).toHaveLength(1);

    const none = setup([], { id: USER, user_metadata: {} });
    await profiles.ensureProfileFromSignup(none.client as never);
    expect(none.queries).toHaveLength(0);
  });

  it("ensureProfileFromSignup never throws", async () => {
    const fake = setup([], { id: USER, user_metadata: { display_name: "An" } });
    fake.client.auth.getUser.mockRejectedValue(new Error("network"));
    await expect(profiles.ensureProfileFromSignup(fake.client as never)).resolves.toBeUndefined();
  });
});
