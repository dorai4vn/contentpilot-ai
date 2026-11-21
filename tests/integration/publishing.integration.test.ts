/**
 * M4.6b publishing data layer against a LOCAL Supabase stack: destinations and
 * deliveries (read-only, RLS), destination-scoped requests and approvals through
 * the M4.2 data layer, and the legacy M4 calls. Real Auth, PostgREST and RLS;
 * createClient() is replaced by the acting user's supabase-js client. No OpenAI,
 * no external platform.
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

import { ContentError } from "@/lib/content/errors";
import { approvePublishRequest, requestPostPublish } from "@/lib/content/publish-requests";
import {
  getInternalDestination,
  getPublishingDestination,
  listPublishDeliveries,
  listPublishingDestinations,
} from "@/lib/publishing/destinations";
import { getPublisher } from "@/lib/publishing/registry";

type Client = SupabaseClient<Database>;
type TestUser = { id: string; client: Client };

const als = new AsyncLocalStorage<Client>();
hoisted.store = als;
const stamp = Date.now();
const as = <T>(user: TestUser, fn: () => Promise<T>): Promise<T> => als.run(user.client, fn);

async function signUp(label: string): Promise<TestUser> {
  const client = createSupabaseClient<Database>(target.supabaseUrl, target.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signUp({ email: `it-pubdest-${label}-${stamp}@example.test`, password: "integration-password-123" });
  if (error || !data.user || !data.session) throw new Error(`sign-up failed for ${label}`);
  return { id: data.user.id, client };
}

async function must<T>(promise: PromiseLike<{ data: T; error: unknown }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as NonNullable<T>;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (e) {
    if (e instanceof ContentError) return e.code;
    throw e;
  }
}

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
const WA = randomUUID();
const WB = randomUUID();
const PA = randomUUID();
const posts = { explicit: randomUUID(), foreign: randomUUID(), mismatch: randomUUID(), legacy: randomUUID() };
let DEST_A = "";
let DEST_B = "";

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all(["owner", "member", "outsider"].map(signUp));
  await must(owner.client.from("workspaces").insert({ id: WA, name: "IT destinations A" }), "WA");
  await must(owner.client.from("workspace_members").insert({ workspace_id: WA, user_id: member.id, role: "member" }), "member");
  await must(owner.client.from("content_projects").insert({ id: PA, workspace_id: WA, name: "Blog" }), "PA");
  await must(
    member.client.from("content_posts").insert(Object.values(posts).map((id) => ({ id, workspace_id: WA, project_id: PA, title: "Bài", body: "x" }))),
    "posts",
  );
  await must(outsider.client.from("workspaces").insert({ id: WB, name: "IT destinations B" }), "WB");
  DEST_A = (await as(owner, () => getInternalDestination({ workspaceId: WA }))).id;
  DEST_B = (await as(outsider, () => getInternalDestination({ workspaceId: WB }))).id;
});

describe("destinations (read-only, RLS)", () => {
  it("every new workspace has its internal destination, visible to its members", async () => {
    const list = await as(member, () => listPublishingDestinations({ workspaceId: WA }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: DEST_A, workspaceId: WA, kind: "internal", name: "Nội bộ", targetRef: null, status: "active" });
    expect(Object.keys(list[0]!).sort()).toEqual(["createdAt", "id", "kind", "name", "status", "targetRef", "workspaceId"]);
    expect(getPublisher(list[0]!.kind).execution).toBe("in_approval");
  });

  it("another workspace's destination is invisible", async () => {
    expect(await as(outsider, () => listPublishingDestinations({ workspaceId: WA, includeDisabled: true }))).toEqual([]);
    expect(await as(outsider, () => getPublishingDestination({ destinationId: DEST_A }))).toBeNull();
    expect(await codeOf(as(outsider, () => getInternalDestination({ workspaceId: WA })))).toBe("not_found");
    expect(await as(member, () => getPublishingDestination({ destinationId: DEST_B }))).toBeNull();
  });

  it("members cannot change destinations; the internal one cannot be disabled", async () => {
    const renamed = await member.client.from("publishing_destinations").update({ name: "Đổi" }).eq("id", DEST_A).select();
    expect(renamed.data).toEqual([]);
    const disabled = await owner.client.from("publishing_destinations").update({ status: "disabled" }).eq("id", DEST_A);
    expect(disabled.error?.code).toBe("42501");
    const external = await owner.client
      .from("publishing_destinations")
      .insert({ workspace_id: WA, kind: "telegram" as never, name: "Telegram", target_ref: "@x" });
    expect(external.error?.code).toBe("23514");
  });
});

describe("destination-scoped requests and approvals", () => {
  it("a request names its destination explicitly and stores it", async () => {
    const r = await as(member, () => requestPostPublish({ postId: posts.explicit, expectedVersion: 1, destinationId: DEST_A }));
    expect(r.destinationId).toBe(DEST_A);
    const row = await must(owner.client.from("content_publish_requests").select("destination_id").eq("id", r.id).single(), "row");
    expect(row.destination_id).toBe(DEST_A);
  });

  it("another workspace's destination is refused, by the data layer and by the database", async () => {
    expect(await codeOf(as(member, () => requestPostPublish({ postId: posts.foreign, expectedVersion: 1, destinationId: DEST_B })))).toBe(
      "not_found",
    );
    const direct = await member.client.rpc("request_post_publish", { p_post_id: posts.foreign, p_expected_version: 1, p_destination_id: DEST_B });
    expect(direct.error?.code).toBe("CP404");
    const { count } = await owner.client
      .from("content_publish_requests")
      .select("id", { count: "exact", head: true })
      .eq("post_id", posts.foreign);
    expect(count).toBe(0);
  });

  it("approval is checked against the destination the approver was shown", async () => {
    const r = await as(member, () => requestPostPublish({ postId: posts.mismatch, expectedVersion: 1, destinationId: DEST_A }));
    expect(await codeOf(as(owner, () => approvePublishRequest({ requestId: r.id, expectedPostVersion: 1, expectedDestinationId: DEST_B })))).toBe(
      "destination_mismatch",
    );
    const direct = await owner.client.rpc("approve_publish_request", {
      p_request_id: r.id,
      p_expected_post_version: 1,
      p_expected_destination_id: DEST_B,
    });
    expect(direct.error?.code).toBe("CP409");
    expect(await as(owner, () => listPublishDeliveries({ workspaceId: WA, requestId: r.id }))).toEqual([]);

    const published = await as(owner, () => approvePublishRequest({ requestId: r.id, expectedPostVersion: 1, expectedDestinationId: DEST_A }));
    expect(published).toMatchObject({ status: "published", version: 2 });

    const deliveries = await as(member, () => listPublishDeliveries({ workspaceId: WA, requestId: r.id }));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      requestId: r.id,
      destinationId: DEST_A,
      postId: posts.mismatch,
      postVersion: 1,
      status: "succeeded",
      attemptCount: 1,
      externalPostId: null,
      lastErrorCode: null,
    });
    expect(deliveries[0]!.completedAt).not.toBeNull();
    expect(await as(member, () => listPublishDeliveries({ workspaceId: WA, postId: posts.mismatch }))).toHaveLength(1);
    expect(await as(outsider, () => listPublishDeliveries({ workspaceId: WA, postId: posts.mismatch }))).toEqual([]);
  });

  it("legacy M4 calls (no destination) still work and map explicitly to internal", async () => {
    const r = await as(member, () => requestPostPublish({ postId: posts.legacy, expectedVersion: 1 }));
    expect(r.destinationId).toBe(DEST_A);
    const published = await as(owner, () => approvePublishRequest({ requestId: r.id, expectedPostVersion: 1 }));
    expect(published.status).toBe("published");
    const [delivery] = await as(owner, () => listPublishDeliveries({ workspaceId: WA, requestId: r.id }));
    expect(delivery).toMatchObject({ destinationId: DEST_A, status: "succeeded" });
  });
});
