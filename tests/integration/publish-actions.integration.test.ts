/**
 * Integration test of the M4.4 publish-approval Server Actions against a LOCAL
 * Supabase stack: real Auth sessions (requireUser), real workspace data, the M4.2
 * data layer and the database RPCs. Replaced: createClient() (reads Next.js
 * cookies) returns the acting user's supabase-js client; revalidatePath (needs a
 * Next.js request context) is recorded. No OpenAI.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/types/database";

import { assertLocalTarget } from "./local-target";

const target = assertLocalTarget(process.env);

vi.mock("server-only", () => ({}));
const hoisted = vi.hoisted(() => ({ store: null as null | { getStore(): unknown }, revalidated: [] as string[] }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const client = hoisted.store?.getStore();
    if (!client) throw new Error("no acting user in this async context");
    return client;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => hoisted.revalidated.push(path) }));

import {
  approvePublishAction,
  cancelPublishAction,
  rejectPublishAction,
  requestPublishAction,
} from "@/app/_actions/content/publish";

type Client = SupabaseClient<Database>;
type TestUser = { id: string; client: Client };

const als = new AsyncLocalStorage<Client>();
hoisted.store = als;
const stamp = Date.now();

function newClient(): Client {
  return createSupabaseClient<Database>(target.supabaseUrl, target.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signUp(label: string): Promise<TestUser> {
  const client = newClient();
  const { data, error } = await client.auth.signUp({ email: `it-act-${label}-${stamp}@example.test`, password: "integration-password-123" });
  if (error || !data.user || !data.session) throw new Error(`sign-up failed for ${label}`);
  return { id: data.user.id, client };
}

const as = <T>(user: TestUser | null, fn: () => Promise<T>): Promise<T> => als.run((user?.client ?? newClient()) as Client, fn);

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

async function must<T>(promise: PromiseLike<{ data: T; error: unknown }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as NonNullable<T>;
}

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
const WA = randomUUID();
const WB = randomUUID();
const PA = randomUUID();
const PB = randomUUID();
const POST1 = randomUUID();
const POST2 = randomUUID();
const POST3 = randomUUID();
const POST_B = randomUUID();

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all(["owner", "member", "outsider"].map(signUp));
  await must(owner.client.from("workspaces").insert({ id: WA, name: "IT actions A" }), "WA");
  await must(owner.client.from("workspace_members").insert({ workspace_id: WA, user_id: member.id, role: "member" }), "member");
  await must(owner.client.from("content_projects").insert({ id: PA, workspace_id: WA, name: "Blog" }), "PA");
  await must(
    member.client.from("content_posts").insert([POST1, POST2, POST3].map((id, i) => ({ id, workspace_id: WA, project_id: PA, title: `Bài ${i + 1}`, body: "x" }))),
    "posts",
  );
  await must(outsider.client.from("workspaces").insert({ id: WB, name: "IT actions B" }), "WB");
  await must(outsider.client.from("content_projects").insert({ id: PB, workspace_id: WB, name: "Blog B" }), "PB");
  await must(outsider.client.from("content_posts").insert({ id: POST_B, workspace_id: WB, project_id: PB, title: "B" }), "post B");
});

describe("publish approval Server Actions on real Supabase", () => {
  let requestId = "";

  it("signed out: redirected to login, nothing written", async () => {
    await expect(
      as(null, () => requestPublishAction(null, form({ workspaceId: WA, postId: POST1, expectedVersion: "1" }))),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    const { count } = await owner.client.from("content_publish_requests").select("id", { count: "exact", head: true }).eq("workspace_id", WA);
    expect(count).toBe(0);
  });

  it("member files a request; a mismatched workspace on the form is refused", async () => {
    const wrongWs = await as(member, () => requestPublishAction(null, form({ workspaceId: WB, postId: POST1, expectedVersion: "1" })));
    expect(wrongWs).toMatchObject({ ok: false, code: "not_found" });

    const result = await as(member, () => requestPublishAction(null, form({ workspaceId: WA, postId: POST1, expectedVersion: "1", reason: "Sẵn sàng" })));
    expect(result).toMatchObject({ ok: true, data: { workspaceId: WA, postId: POST1, requestStatus: "pending" } });
    requestId = (result as { data: { requestId: string } }).data.requestId;
    expect(hoisted.revalidated).toContain(`/w/${WA}/approvals`);

    const again = await as(member, () => requestPublishAction(null, form({ workspaceId: WA, postId: POST1, expectedVersion: "1" })));
    expect(again).toMatchObject({ ok: false, code: "request_pending_exists", error: "Bài viết này đã có một yêu cầu xuất bản đang chờ duyệt." });
  });

  it("filing a request publishes nothing (no implicit approval)", async () => {
    const post = await must(owner.client.from("content_posts").select("status").eq("id", POST1).single(), "post");
    expect(post.status).toBe("draft");
  });

  it("member cannot approve; outsider cannot see it; wrong workspace on the form is refused", async () => {
    const byMember = await as(member, () =>
      approvePublishAction(null, form({ workspaceId: WA, requestId, expectedPostVersion: "1", confirm: "approve" })),
    );
    expect(byMember).toMatchObject({ ok: false, code: "forbidden" });
    const byOutsider = await as(outsider, () =>
      approvePublishAction(null, form({ workspaceId: WA, requestId, expectedPostVersion: "1", confirm: "approve" })),
    );
    expect(byOutsider).toMatchObject({ ok: false, code: "not_found" });
    const outsiderOwnWs = await as(outsider, () =>
      approvePublishAction(null, form({ workspaceId: WB, requestId, expectedPostVersion: "1", confirm: "approve" })),
    );
    expect(outsiderOwnWs).toMatchObject({ ok: false, code: "not_found" });
    const ownerWrongWs = await as(owner, () =>
      approvePublishAction(null, form({ workspaceId: WB, requestId, expectedPostVersion: "1", confirm: "approve" })),
    );
    expect(ownerWrongWs).toMatchObject({ ok: false, code: "not_found" });
  });

  it("forged approver/role fields are refused before anything runs", async () => {
    const forged = await as(member, () =>
      approvePublishAction(null, form({ workspaceId: WA, requestId, expectedPostVersion: "1", confirm: "approve", role: "owner", decidedBy: owner.id })),
    );
    expect(forged).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("owner approves explicitly; repeating is refused", async () => {
    const stale = await as(owner, () => approvePublishAction(null, form({ workspaceId: WA, requestId, expectedPostVersion: "2", confirm: "approve" })));
    expect(stale).toMatchObject({ ok: false, code: "version_conflict" });

    const result = await as(owner, () => approvePublishAction(null, form({ workspaceId: WA, requestId, expectedPostVersion: "1", confirm: "approve" })));
    expect(result).toMatchObject({ ok: true, data: { postStatus: "published", postVersion: 2, requestStatus: "approved" } });
    expect(hoisted.revalidated).toContain(`/w/${WA}/p/${PA}`);

    const again = await as(owner, () => approvePublishAction(null, form({ workspaceId: WA, requestId, expectedPostVersion: "1", confirm: "approve" })));
    expect(again).toMatchObject({ ok: false, code: "request_closed" });
    const post = await must(owner.client.from("content_posts").select("status, version").eq("id", POST1).single(), "post");
    expect(post).toEqual({ status: "published", version: 2 });

    const rerequest = await as(member, () => requestPublishAction(null, form({ workspaceId: WA, postId: POST1, expectedVersion: "2" })));
    expect(rerequest).toMatchObject({ ok: false, code: "post_published" });
  });

  it("owner rejects; the requester cancels another request", async () => {
    const r2 = await as(member, () => requestPublishAction(null, form({ workspaceId: WA, postId: POST2, expectedVersion: "1" })));
    const id2 = (r2 as { data: { requestId: string } }).data.requestId;
    expect(await as(member, () => rejectPublishAction(null, form({ workspaceId: WA, requestId: id2 })))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await as(owner, () => rejectPublishAction(null, form({ workspaceId: WA, requestId: id2, note: "Chưa đạt" })))).toMatchObject({
      ok: true,
      data: { requestStatus: "rejected" },
    });

    const r3 = await as(member, () => requestPublishAction(null, form({ workspaceId: WA, postId: POST3, expectedVersion: "1" })));
    const id3 = (r3 as { data: { requestId: string } }).data.requestId;
    expect(await as(outsider, () => cancelPublishAction(null, form({ workspaceId: WA, requestId: id3 })))).toMatchObject({ ok: false, code: "not_found" });
    expect(await as(member, () => cancelPublishAction(null, form({ workspaceId: WA, requestId: id3 })))).toMatchObject({
      ok: true,
      data: { requestStatus: "cancelled" },
    });
    const statuses = await must(owner.client.from("content_posts").select("id, status").in("id", [POST2, POST3]), "posts");
    expect(statuses.every((p) => p.status === "draft")).toBe(true);
  });
});
