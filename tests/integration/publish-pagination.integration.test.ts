/**
 * Server-side pagination of the approval queue against a LOCAL Supabase stack:
 * large lists, exact counts per status, stable order across pages (including
 * identical timestamps) and workspace isolation. Real Auth, PostgREST, RLS and the
 * M4.2 data layer; createClient() is replaced by the acting user's supabase-js
 * client. Superuser SQL on the LOCAL database is used only to move requests into
 * the past (expiry / identical timestamps). No OpenAI.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
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

import { approvePublishRequest, countPublishRequests, listPublishRequestsPage, requestPostPublish } from "@/lib/content/publish-requests";

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
  const { data, error } = await client.auth.signUp({ email: `it-page-${label}-${stamp}@example.test`, password: "integration-password-123" });
  if (error || !data.user || !data.session) throw new Error(`sign-up failed for ${label}`);
  return { id: data.user.id, client };
}

function psql(query: string): string {
  return execFileSync("psql", [target.dbUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();
}

async function must<T>(promise: PromiseLike<{ data: T; error: unknown }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as NonNullable<T>;
}

/** Walks every page of a filter and returns the ids in page order. */
async function walk(user: TestUser, workspaceId: string, filter: "pending" | "expired" | "approved" | "all", pageSize: number) {
  const ids: string[] = [];
  let page = 1;
  let totalPages = 1;
  let total = -1;
  do {
    const result = await as(user, () => listPublishRequestsPage({ workspaceId, filter, page, pageSize }));
    expect(result.items.length).toBeLessThanOrEqual(pageSize);
    if (total >= 0) expect(result.total).toBe(total); // stable total while walking
    total = result.total;
    totalPages = result.totalPages;
    ids.push(...result.items.map((r) => r.id));
    page += 1;
  } while (page <= totalPages);
  return { ids, total, totalPages };
}

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
const W1 = randomUUID();
const W2 = randomUUID();
const P1 = randomUUID();
const P2 = randomUUID();
const N = 45; // requests in W1: 30 pending, 10 approved, 5 expired
const W2_N = 7;

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all(["owner", "member", "outsider"].map(signUp));
  await must(owner.client.from("workspaces").insert({ id: W1, name: "IT pagination 1" }), "W1");
  await must(owner.client.from("workspace_members").insert({ workspace_id: W1, user_id: member.id, role: "member" }), "member");
  await must(owner.client.from("content_projects").insert({ id: P1, workspace_id: W1, name: "Blog" }), "P1");
  const posts = Array.from({ length: N }, () => randomUUID());
  await must(
    member.client.from("content_posts").insert(posts.map((id, i) => ({ id, workspace_id: W1, project_id: P1, title: `Bài ${i}`, body: "x" }))),
    "posts W1",
  );
  const requestIds: string[] = [];
  for (const postId of posts) {
    const r = await as(member, () => requestPostPublish({ postId, expectedVersion: 1 }));
    requestIds.push(r.id);
  }
  for (const id of requestIds.slice(0, 10)) {
    await as(owner, () => approvePublishRequest({ requestId: id, expectedPostVersion: 1 }));
  }
  // 5 expired; and 6 pending requests sharing one identical requested_at (tie-breaker test).
  const list = (ids: string[]) => ids.map((id) => `'${id}'`).join(",");
  psql(`set session_replication_role = replica;
        update public.content_publish_requests set requested_at = requested_at - interval '8 days', expires_at = expires_at - interval '8 days'
         where id in (${list(requestIds.slice(10, 15))});
        update public.content_publish_requests set requested_at = timestamptz '2026-11-20 08:00:00+00', expires_at = timestamptz '2026-11-27 08:00:00+00'
         where id in (${list(requestIds.slice(15, 21))});`);

  await must(outsider.client.from("workspaces").insert({ id: W2, name: "IT pagination 2" }), "W2");
  await must(outsider.client.from("content_projects").insert({ id: P2, workspace_id: W2, name: "Blog 2" }), "P2");
  const posts2 = Array.from({ length: W2_N }, () => randomUUID());
  await must(
    outsider.client.from("content_posts").insert(posts2.map((id, i) => ({ id, workspace_id: W2, project_id: P2, title: `B ${i}`, body: "y" }))),
    "posts W2",
  );
  for (const postId of posts2) await as(outsider, () => requestPostPublish({ postId, expectedVersion: 1 }));
}, 120_000);

describe("approval queue pagination (real Supabase)", () => {
  it("counts exactly per display status, beyond any fixed limit", async () => {
    expect(await as(member, () => countPublishRequests({ workspaceId: W1 }))).toEqual({
      pending: 30,
      expired: 5,
      approved: 10,
      rejected: 0,
      cancelled: 0,
      all: 45,
    });
  });

  it("walks pending in pages of 20: 20 + 10, no gaps, no duplicates, database order", async () => {
    const first = await as(owner, () => listPublishRequestsPage({ workspaceId: W1, filter: "pending", page: 1, pageSize: 20 }));
    expect(first).toMatchObject({ total: 30, totalPages: 2, page: 1 });
    expect(first.items).toHaveLength(20);
    expect(first.items.every((r) => r.displayStatus === "pending")).toBe(true);

    const { ids } = await walk(owner, W1, "pending", 20);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    const expected = psql(
      `select string_agg(id::text, ',' order by requested_at desc, id desc) from public.content_publish_requests
        where workspace_id = '${W1}' and status = 'pending' and expires_at > now()`,
    ).split(",");
    expect(ids).toEqual(expected);
  });

  it("identical timestamps: small pages (size 4) still return every row exactly once", async () => {
    const { ids, totalPages } = await walk(member, W1, "all", 4);
    expect(totalPages).toBe(12);
    expect(ids).toHaveLength(45);
    expect(new Set(ids).size).toBe(45);
    const tied = psql(
      `select count(*) from public.content_publish_requests where workspace_id = '${W1}' and requested_at = timestamptz '2026-11-20 08:00:00+00'`,
    );
    expect(tied).toBe("6");
  });

  it("expired and approved filters are separate and complete", async () => {
    const expired = await walk(owner, W1, "expired", 3);
    expect(expired.ids).toHaveLength(5);
    const approved = await walk(owner, W1, "approved", 20);
    expect(approved.ids).toHaveLength(10);
    const pending = await walk(owner, W1, "pending", 20);
    expect(new Set([...expired.ids, ...approved.ids, ...pending.ids]).size).toBe(45);
  });

  it("a page past the end is empty but keeps the exact total", async () => {
    const result = await as(owner, () => listPublishRequestsPage({ workspaceId: W1, filter: "pending", page: 99, pageSize: 20 }));
    expect(result).toMatchObject({ items: [], total: 30, totalPages: 2 });
  });

  it("workspace isolation: no rows or counts of another workspace", async () => {
    const own = await walk(outsider, W2, "all", 5);
    expect(own.ids).toHaveLength(W2_N);
    const w1ids = new Set((await walk(owner, W1, "all", 50)).ids);
    expect(own.ids.some((id) => w1ids.has(id))).toBe(false);

    // The outsider asking for W1 sees nothing (RLS), not even counts.
    const probe = await as(outsider, () => listPublishRequestsPage({ workspaceId: W1, filter: "all", page: 1, pageSize: 50 }));
    expect(probe).toMatchObject({ items: [], total: 0, totalPages: 1 });
    expect(await as(outsider, () => countPublishRequests({ workspaceId: W1 }))).toEqual({
      pending: 0,
      expired: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
      all: 0,
    });
  });
});
