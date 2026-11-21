/**
 * M4.5.2 user profiles against a LOCAL Supabase stack: real Auth sessions,
 * PostgREST, RLS and the profiles data layer. createClient() is replaced by the
 * acting user's supabase-js client. No OpenAI.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/types/database";

import { assertLocalTarget } from "./local-target";

const target = assertLocalTarget(process.env);

vi.mock("server-only", () => ({}));
const hoisted = vi.hoisted(() => ({ store: null as null | { getStore(): unknown } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const client = hoisted.store?.getStore();
    if (!client) throw new Error("no acting user in this async context");
    return client;
  },
}));

import { ensureProfileFromSignup, getMyProfile, listDisplayNames, updateMyDisplayName } from "@/lib/profiles/profiles";

type Client = SupabaseClient<Database>;
type TestUser = { id: string; client: Client };

const als = new AsyncLocalStorage<Client>();
hoisted.store = als;
const stamp = Date.now();
const as = <T>(user: TestUser, fn: () => Promise<T>): Promise<T> => als.run(user.client, fn);

function newClient(): Client {
  return createSupabaseClient<Database>(target.supabaseUrl, target.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signUp(label: string, metadata?: Record<string, string>): Promise<TestUser> {
  const client = newClient();
  const { data, error } = await client.auth.signUp({
    email: `it-prof-${label}-${stamp}@example.test`,
    password: "integration-password-123",
    ...(metadata ? { options: { data: metadata } } : {}),
  });
  if (error || !data.user || !data.session) throw new Error(`sign-up failed for ${label}`);
  return { id: data.user.id, client };
}

async function must<T>(promise: PromiseLike<{ data: T; error: unknown }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as NonNullable<T>;
}

let an: TestUser; // owner of WA
let binh: TestUser; // member of WA
let chi: TestUser; // owner of WB, outsider to WA
let dung: TestUser; // member of WA and WB
const WA = randomUUID();
const WB = randomUUID();

beforeAll(async () => {
  [an, binh, chi, dung] = await Promise.all(["an", "binh", "chi", "dung"].map((l) => signUp(l)));
  await must(an.client.from("workspaces").insert({ id: WA, name: "IT profiles A" }), "WA");
  await must(
    an.client.from("workspace_members").insert([
      { workspace_id: WA, user_id: binh.id, role: "member" },
      { workspace_id: WA, user_id: dung.id, role: "member" },
    ]),
    "members WA",
  );
  await must(chi.client.from("workspaces").insert({ id: WB, name: "IT profiles B" }), "WB");
  await must(chi.client.from("workspace_members").insert({ workspace_id: WB, user_id: dung.id, role: "member" }), "member WB");
});

describe("profiles on real Supabase", () => {
  it("a new user has no profile; the data layer returns null", async () => {
    expect(await as(an, () => getMyProfile())).toBeNull();
  });

  it("create then rename through the data layer (real upsert)", async () => {
    expect(await as(an, () => updateMyDisplayName({ displayName: "  Nguyễn   An " }))).toMatchObject({ displayName: "Nguyễn An" });
    expect(await as(an, () => updateMyDisplayName({ displayName: "An Nguyễn" }))).toMatchObject({ displayName: "An Nguyễn" });
    expect(await as(an, () => getMyProfile())).toMatchObject({ displayName: "An Nguyễn" });
    await as(binh, () => updateMyDisplayName({ displayName: "Bình" }));
    await as(chi, () => updateMyDisplayName({ displayName: "Chi" }));
    await as(dung, () => updateMyDisplayName({ displayName: "Dũng" }));
    const rows = await must(an.client.from("user_profiles").select("user_id").eq("user_id", an.id), "own row");
    expect(rows).toHaveLength(1);
  });

  it("names are visible to fellow members only (cross-workspace)", async () => {
    const all = [an.id, binh.id, chi.id, dung.id];
    const forBinh = await as(binh, () => listDisplayNames(all));
    expect(Object.fromEntries(forBinh)).toEqual({ [an.id]: "An Nguyễn", [binh.id]: "Bình", [dung.id]: "Dũng" });
    const forChi = await as(chi, () => listDisplayNames(all));
    expect(Object.fromEntries(forChi)).toEqual({ [chi.id]: "Chi", [dung.id]: "Dũng" });
    const forDung = await as(dung, () => listDisplayNames(all));
    expect(forDung.size).toBe(4);
  });

  it("an outsider cannot read a profile even by id", async () => {
    const { data } = await chi.client.from("user_profiles").select("display_name").eq("user_id", an.id);
    expect(data).toEqual([]);
  });

  it("forged user_id, foreign updates and deletes are refused", async () => {
    const forged = await binh.client.from("user_profiles").insert({ user_id: an.id, display_name: "Giả An" } as never);
    expect(forged.error?.code).toBe("42501");
    const moved = await binh.client.from("user_profiles").update({ user_id: an.id } as never).eq("user_id", binh.id);
    expect(moved.error?.code).toBe("42501");
    const renamed = await binh.client.from("user_profiles").update({ display_name: "Bị sửa" }).eq("user_id", an.id).select();
    expect(renamed.error).toBeNull();
    expect(renamed.data).toEqual([]);
    const deleted = await binh.client.from("user_profiles").delete().eq("user_id", an.id);
    expect(deleted.error?.code).toBe("42501");
    expect(await as(an, () => getMyProfile())).toMatchObject({ displayName: "An Nguyễn" });
    // The data layer accepts no user id at all.
    await expect(as(binh, () => updateMyDisplayName({ displayName: "X", userId: an.id }))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("invalid names are rejected by the database too", async () => {
    for (const name of ["", "  padded  ", "x".repeat(61), "A\nB"]) {
      const { error } = await binh.client.from("user_profiles").update({ display_name: name }).eq("user_id", binh.id);
      expect(error?.code, JSON.stringify(name)).toBe("23514");
    }
  });

  it("clients cannot read auth.users or emails through the API", async () => {
    const { data, error } = await an.client.schema("auth" as never).from("users" as never).select("email");
    expect(data ?? []).toEqual([]);
    expect(error).not.toBeNull();
    const { data: profiles } = await an.client.from("user_profiles").select("*").eq("user_id", an.id);
    expect(Object.keys(profiles![0]!).sort()).toEqual(["created_at", "display_name", "updated_at", "user_id"]);
    expect(JSON.stringify(profiles)).not.toMatch(/@example\.test/);
  });

  it("the sign-up name kept in metadata becomes the profile after confirmation", async () => {
    const eve = await signUp("eve", { display_name: "  Eve Trần " });
    await ensureProfileFromSignup(eve.client as never);
    expect(await as(eve, () => getMyProfile())).toMatchObject({ displayName: "Eve Trần" });
    // Idempotent: an existing profile is never overwritten by metadata.
    await as(eve, () => updateMyDisplayName({ displayName: "Eve" }));
    await ensureProfileFromSignup(eve.client as never);
    expect(await as(eve, () => getMyProfile())).toMatchObject({ displayName: "Eve" });
  });
});
