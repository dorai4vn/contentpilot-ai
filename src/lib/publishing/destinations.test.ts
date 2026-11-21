import { beforeEach, describe, expect, it, vi } from "vitest";

import { dbError, fakeSupabase, ok, type FakeResult } from "@/lib/content/__tests__/fake-supabase";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), getCurrentUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth/dal", () => ({ getCurrentUser: mocks.getCurrentUser }));

import { ContentError } from "@/lib/content/errors";

import * as destinations from "./destinations";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const DEST = "88888888-8888-4888-8888-888888888888";
const EXT = "99999999-0000-4000-8000-000000000001";
const POST = "44444444-4444-4444-8444-444444444444";
const REQUEST = "66666666-6666-4666-8666-666666666666";

const destRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: WS,
  kind: "internal",
  name: "Nội bộ",
  target_ref: null,
  status: "active",
  created_at: "2026-11-01T00:00:00Z",
  ...over,
});
const deliveryRow = {
  id: "d1",
  workspace_id: WS,
  request_id: REQUEST,
  destination_id: DEST,
  post_id: POST,
  post_version: 3,
  status: "succeeded",
  attempt_count: 1,
  next_attempt_at: null,
  external_post_id: null,
  last_error_code: null,
  created_at: "2026-11-20T12:00:00Z",
  completed_at: "2026-11-20T12:00:00Z",
};

function setup(results: FakeResult[]) {
  const fake = fakeSupabase(results);
  mocks.createClient.mockResolvedValue(fake.client);
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUser.mockResolvedValue({ id: USER, email: null });
});

describe("module surface", () => {
  it("is read-only (no write function)", () => {
    expect(Object.keys(destinations).sort()).toEqual(
      [
        "getInternalDestination",
        "getPublishingDestination",
        "listPublishDeliveries",
        "listPublishingDestinations",
        "resolveRequestDestination",
        "toDestination",
      ].sort(),
    );
  });
});

describe("listPublishingDestinations", () => {
  it("reads one workspace's active destinations, internal first, no secrets selected", async () => {
    const fake = setup([ok([destRow(EXT, { kind: "internal", name: "Ă" }), destRow(DEST)].reverse())]);
    const result = await destinations.listPublishingDestinations({ workspaceId: WS });
    const query = fake.queries[0]!;
    expect(query.table).toBe("publishing_destinations");
    expect(query.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(query.calls).toContainEqual(["eq", ["status", "active"]]);
    expect(String(query.args("select")?.[0])).not.toMatch(/token|secret|credential/);
    expect(result.map((d) => d.id)).toHaveLength(2);
  });

  it("includes disabled ones on request", async () => {
    const fake = setup([ok([destRow(DEST)])]);
    await destinations.listPublishingDestinations({ workspaceId: WS, includeDisabled: true });
    expect(fake.queries[0]!.calls.filter(([m, a]) => m === "eq" && a[0] === "status")).toHaveLength(0);
  });

  it.each([{ workspaceId: "nope" }, { workspaceId: WS, userId: USER }, { workspaceId: WS, kind: "telegram" }])(
    "rejects invalid input %j",
    async (input) => {
      const fake = setup([]);
      await expect(destinations.listPublishingDestinations(input)).rejects.toMatchObject({ code: "invalid_input" });
      expect(fake.queries).toHaveLength(0);
    },
  );
});

describe("getPublishingDestination / getInternalDestination", () => {
  it("returns null when not visible", async () => {
    setup([ok(null)]);
    expect(await destinations.getPublishingDestination({ destinationId: DEST })).toBeNull();
  });

  it("maps a row without exposing anything else", async () => {
    setup([ok(destRow(DEST))]);
    expect(await destinations.getPublishingDestination({ destinationId: DEST })).toEqual({
      id: DEST,
      workspaceId: WS,
      kind: "internal",
      name: "Nội bộ",
      targetRef: null,
      status: "active",
      createdAt: "2026-11-01T00:00:00Z",
    });
  });

  it("finds the internal destination of a workspace", async () => {
    const fake = setup([ok(destRow(DEST))]);
    expect((await destinations.getInternalDestination({ workspaceId: WS })).id).toBe(DEST);
    expect(fake.queries[0]!.calls).toContainEqual(["eq", ["kind", "internal"]]);
  });

  it("not_found when the workspace is not visible", async () => {
    setup([ok(null)]);
    await expect(destinations.getInternalDestination({ workspaceId: OTHER_WS })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("resolveRequestDestination", () => {
  it("explicit destination: same workspace and active", async () => {
    const fake = fakeSupabase([ok(destRow(EXT, { name: "Kênh" }))]);
    const d = await destinations.resolveRequestDestination(fake.client as never, WS, EXT);
    expect(d.id).toBe(EXT);
  });

  it.each([
    ["other workspace", ok(destRow(EXT, { workspace_id: OTHER_WS })), "not_found"],
    ["invisible", ok(null), "not_found"],
    ["disabled", ok(destRow(EXT, { status: "disabled" })), "destination_disabled"],
    ["db error", dbError("XX000"), "unknown"],
  ] as const)("%s -> %s", async (_label, result, code) => {
    const fake = fakeSupabase([result]);
    await expect(destinations.resolveRequestDestination(fake.client as never, WS, EXT)).rejects.toMatchObject({ code });
  });

  it("no destination: explicitly the workspace's internal one", async () => {
    const fake = fakeSupabase([ok(destRow(DEST))]);
    const d = await destinations.resolveRequestDestination(fake.client as never, WS, undefined);
    expect(d.id).toBe(DEST);
    expect(fake.queries[0]!.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(fake.queries[0]!.calls).toContainEqual(["eq", ["kind", "internal"]]);
  });
});

describe("listPublishDeliveries", () => {
  it("reads the deliveries of one request in one workspace, newest first, without the idempotency key", async () => {
    const fake = setup([ok([deliveryRow])]);
    const result = await destinations.listPublishDeliveries({ workspaceId: WS, requestId: REQUEST });
    const query = fake.queries[0]!;
    expect(query.table).toBe("publish_deliveries");
    expect(query.calls).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(query.calls).toContainEqual(["eq", ["request_id", REQUEST]]);
    expect(String(query.args("select")?.[0])).not.toMatch(/idempotency_key/);
    expect(result[0]).toMatchObject({ status: "succeeded", destinationId: DEST, postVersion: 3, attemptCount: 1 });
  });

  it("filters by post", async () => {
    const fake = setup([ok([])]);
    await destinations.listPublishDeliveries({ workspaceId: WS, postId: POST });
    expect(fake.queries[0]!.calls).toContainEqual(["eq", ["post_id", POST]]);
  });

  it.each([
    { workspaceId: WS },
    { workspaceId: WS, postId: POST, requestId: REQUEST },
    { workspaceId: "nope", postId: POST },
    { workspaceId: WS, postId: POST, limit: 1000 },
  ])("requires exactly one of post or request, valid ids %j", async (input) => {
    const fake = setup([]);
    await expect(destinations.listPublishDeliveries(input)).rejects.toBeInstanceOf(ContentError);
    expect(fake.queries).toHaveLength(0);
  });
});
