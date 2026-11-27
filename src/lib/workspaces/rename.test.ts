import { beforeEach, describe, expect, it, vi } from "vitest";

import { dbError, fakeSupabase, ok, type FakeResult } from "@/lib/content/__tests__/fake-supabase";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { renameWorkspace } from "./queries";

const WS = "22222222-2222-4222-8222-222222222222";

function setup(results: FakeResult[]) {
  const fake = fakeSupabase(results);
  mocks.createClient.mockResolvedValue(fake.client);
  return fake;
}

beforeEach(() => vi.clearAllMocks());

describe("renameWorkspace", () => {
  it("updates only the name of the given workspace", async () => {
    const fake = setup([ok([{ id: WS }])]);
    await renameWorkspace(WS, "Tên mới");
    const q = fake.queries[0];
    expect(q.table).toBe("workspaces");
    expect(q.args("update")).toEqual([{ name: "Tên mới" }]);
    expect(q.args("eq")).toEqual(["id", WS]);
  });

  it("rejects when RLS blocks the update (zero rows)", async () => {
    setup([ok([])]);
    await expect(renameWorkspace(WS, "x")).rejects.toThrow("not permitted");
  });

  it("hides database errors", async () => {
    setup([dbError("42501")]);
    await expect(renameWorkspace(WS, "x")).rejects.toThrow("Could not rename workspace");
  });
});
