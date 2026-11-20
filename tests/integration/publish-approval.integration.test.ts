/**
 * Integration tests of M4 human approval against a LOCAL Supabase stack.
 *
 * REAL: Supabase Auth users (sign-up on the local stack), PostgREST, Postgres
 * RLS / RPCs / triggers of supabase/migrations/20261120200000_publish_approval.sql,
 * the auth DAL and the M4.2 data layer (src/lib/content/publish-requests.ts).
 * REPLACED: only createClient() from src/lib/supabase/server.ts (it reads Next.js
 * cookies); here it returns a real supabase-js client signed in as the acting user,
 * chosen per async context so two users can act truly concurrently.
 * Superuser SQL on the LOCAL database is used only as a test harness: to hold a
 * row lock (forcing real contention) and to move a request 8 days into the past.
 * No OpenAI, no model.
 *
 * Run with `npm run test:integration` (refuses non-local targets).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/types/database";

import { assertLocalTarget } from "./local-target";

const target = assertLocalTarget(process.env);

vi.mock("server-only", () => ({}));
const acting = vi.hoisted(() => ({ store: null as null | { getStore(): unknown } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const client = acting.store?.getStore();
    if (!client) throw new Error("no acting user in this async context");
    return client;
  },
}));

import { ContentError } from "@/lib/content/errors";
import { updatePost } from "@/lib/content/posts";
import * as publish from "@/lib/content/publish-requests";

type Client = SupabaseClient<Database>;
type TestUser = { id: string; email: string; client: Client };

const als = new AsyncLocalStorage<Client>();
acting.store = als;

const PASSWORD = "integration-password-123";
const stamp = Date.now();

function newClient(headers: Record<string, string> = {}): Client {
  return createSupabaseClient<Database>(target.supabaseUrl, target.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers },
  });
}

async function signUp(label: string): Promise<TestUser> {
  const client = newClient();
  const email = `it-pub-${label}-${stamp}@example.test`;
  const { data, error } = await client.auth.signUp({ email, password: PASSWORD });
  if (error || !data.session || !data.user) throw new Error(`sign-up failed for ${label}: ${error?.message}`);
  return { id: data.user.id, email, client };
}

/** The same user, signed in again on a client whose every request carries the AI agent marker header. */
async function agentClientOf(user: TestUser): Promise<Client> {
  const client = newClient({ "x-contentpilot-actor": "agent" });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: PASSWORD });
  if (error) throw new Error(`agent sign-in failed: ${error.message}`);
  return client;
}

/** Runs data-layer code as `user` (per async context, safe under concurrency). */
const as = <T>(user: TestUser, fn: () => Promise<T>): Promise<T> => als.run(user.client, fn);

function psql(query: string): string {
  return execFileSync("psql", [target.dbUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
  }).trim();
}

/**
 * Holds FOR UPDATE on a post for `ms` in a separate LOCAL connection, so that
 * calls started meanwhile all queue on the row lock and then race for it.
 */
async function holdPostLock(postId: string, ms: number): Promise<{ released: Promise<void> }> {
  const tag = `it_lock_${randomUUID().replaceAll("-", "")}`;
  const child = spawn(
    "psql",
    [
      target.dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c",
      `begin; select '${tag}'; select 1 from public.content_posts where id = '${postId}' for update; select pg_sleep(${ms / 1000}); commit;`,
    ],
    { stdio: "ignore" },
  );
  const released = new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`))));
  });
  // Wait until the lock holder is sleeping (lock acquired).
  for (let i = 0; i < 100; i++) {
    const n = psql(`select count(*) from pg_stat_activity where query like '%${tag}%' and query like '%pg_sleep%' and pid <> pg_backend_pid() and wait_event = 'PgSleep'`);
    if (n === "1") return { released };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("lock holder did not start");
}

/** Number of sessions currently waiting on a lock for the given post (from the lock holder's view). */
function waitersOnLock(): number {
  return Number(psql(`select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`));
}

async function waitForWaiters(n: number) {
  for (let i = 0; i < 100; i++) {
    if (waitersOnLock() >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`expected ${n} sessions waiting on the row lock`);
}

/** Moves a request 8 days into the past (LOCAL superuser; bypasses the request triggers). */
function backdate(requestId: string) {
  psql(
    `set session_replication_role = replica;
     update public.content_publish_requests
        set requested_at = requested_at - interval '8 days', expires_at = expires_at - interval '8 days'
      where id = '${requestId}';`,
  );
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

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (e) {
    if (e instanceof ContentError) return { ok: false, code: e.code };
    throw e;
  }
}

/** Audit trail of a request as "event[:cancel_reason]" strings in lifecycle order (superuser view). */
function events(requestId: string): string[] {
  const out = psql(
    `select string_agg(event::text || coalesce(':' || cancel_reason::text, ''), ',' order by created_at, event)
       from public.content_publish_request_events where request_id = '${requestId}'`,
  );
  return out ? out.split(",") : [];
}

function postState(postId: string) {
  const [status, version, publishedAt, body] = psql(
    `select status || '|' || version || '|' || coalesce(published_at::text, '') || '|' || body from public.content_posts where id = '${postId}'`,
  ).split("|");
  return { status, version: Number(version), published: publishedAt !== "", body };
}

// ---------------------------------------------------------------------------
// Fixtures: WA (owner alice, admin adam, members carol and dan), WB (owner bob).
// ---------------------------------------------------------------------------

let alice: TestUser;
let adam: TestUser;
let carol: TestUser;
let dan: TestUser;
let bob: TestUser;
const WA = randomUUID();
const WB = randomUUID();
const PA = randomUUID();
const PB = randomUUID();
const post = Object.fromEntries(
  ["approve", "reject", "cancel", "expire", "expireCancel", "changed", "self", "replay", "raceApprove", "raceEdit", "raceEdit2", "raceRequest", "direct", "agent"].map(
    (k) => [k, randomUUID()],
  ),
) as Record<string, string>;
const POST_B = randomUUID();

beforeAll(async () => {
  [alice, adam, carol, dan, bob] = await Promise.all(["alice", "adam", "carol", "dan", "bob"].map(signUp));

  await must(alice.client.from("workspaces").insert({ id: WA, name: "IT approval A" }), "create WA");
  await must(
    alice.client.from("workspace_members").insert([
      { workspace_id: WA, user_id: adam.id, role: "admin" },
      { workspace_id: WA, user_id: carol.id, role: "member" },
      { workspace_id: WA, user_id: dan.id, role: "member" },
    ]),
    "members WA",
  );
  await must(alice.client.from("content_projects").insert({ id: PA, workspace_id: WA, name: "Blog A" }), "project A");
  await must(
    carol.client.from("content_posts").insert(
      Object.entries(post).map(([k, id]) => ({ id, workspace_id: WA, project_id: PA, title: `Bài ${k}`, body: `Nội dung ${k}` })),
    ),
    "posts A",
  );

  await must(bob.client.from("workspaces").insert({ id: WB, name: "IT approval B" }), "create WB");
  await must(bob.client.from("content_projects").insert({ id: PB, workspace_id: WB, name: "Blog B" }), "project B");
  await must(bob.client.from("content_posts").insert({ id: POST_B, workspace_id: WB, project_id: PB, title: "Bài B" }), "post B");
});

// ---------------------------------------------------------------------------
// 1. Full flows through the M4.2 data layer
// ---------------------------------------------------------------------------

describe("flows (data layer on real Supabase)", () => {
  it("member requests, owner approves: the requested version is published", async () => {
    const request = await as(carol, () =>
      publish.requestPostPublish({ postId: post.approve, expectedVersion: 1, reason: "Sẵn sàng đăng" }),
    );
    expect(request).toMatchObject({ status: "pending", displayStatus: "pending", postVersion: 1, requestedBy: carol.id, requestSource: "user" });
    expect(Date.parse(request.expiresAt) - Date.parse(request.requestedAt)).toBe(7 * 24 * 3600 * 1000);

    const listed = await as(alice, () => publish.listPublishRequests({ workspaceId: WA, status: "pending", postId: post.approve }));
    expect(listed.map((r) => r.id)).toEqual([request.id]);

    const published = await as(alice, () => publish.approvePublishRequest({ requestId: request.id, expectedPostVersion: 1 }));
    expect(published).toMatchObject({ id: post.approve, status: "published", version: 2, updatedBy: alice.id });

    expect(postState(post.approve)).toMatchObject({ status: "published", version: 2, published: true, body: "Nội dung approve" });
    const detail = await as(carol, () => publish.getPublishRequest({ requestId: request.id }));
    expect(detail?.request).toMatchObject({ status: "approved", decidedBy: alice.id });
    expect(detail?.events.map((e) => `${e.event}:${e.actorSource}`)).toEqual(["requested:user", "approved:user", "published:user"]);
    expect(detail?.events.map((e) => e.actorId)).toEqual([carol.id, alice.id, alice.id]);

    // The published post is read-only, also through the M2 data layer.
    expect(
      await codeOf(as(alice, () => updatePost({ postId: post.approve, expectedVersion: 2, title: "Sửa", body: "x", status: "draft", scheduledFor: null }))),
    ).toBe("post_published");
    expect(await codeOf(as(carol, () => publish.requestPostPublish({ postId: post.approve, expectedVersion: 2 })))).toBe("post_published");
  });

  it("admin rejects: the post stays a draft", async () => {
    const request = await as(carol, () => publish.requestPostPublish({ postId: post.reject, expectedVersion: 1 }));
    const rejected = await as(adam, () => publish.rejectPublishRequest({ requestId: request.id, note: " Cần sửa tiêu đề " }));
    expect(rejected).toMatchObject({ status: "rejected", decidedBy: adam.id, decisionNote: "Cần sửa tiêu đề" });
    expect(postState(post.reject)).toMatchObject({ status: "draft", version: 1, published: false });
    expect(events(request.id)).toEqual(["requested", "rejected"]);
    expect(await codeOf(as(alice, () => publish.approvePublishRequest({ requestId: request.id, expectedPostVersion: 1 })))).toBe("request_closed");
  });

  it("the requester withdraws their request", async () => {
    const request = await as(carol, () => publish.requestPostPublish({ postId: post.cancel, expectedVersion: 1 }));
    expect(await codeOf(as(dan, () => publish.cancelPublishRequest({ requestId: request.id })))).toBe("forbidden");
    const cancelled = await as(carol, () => publish.cancelPublishRequest({ requestId: request.id }));
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "withdrawn" });
    expect(await codeOf(as(carol, () => publish.cancelPublishRequest({ requestId: request.id })))).toBe("request_closed");
    expect(postState(post.cancel).status).toBe("draft");
    expect(events(request.id)).toEqual(["requested", "cancelled:withdrawn"]);
  });

  it("a request expires after 7 days and cannot be approved or rejected", async () => {
    const request = await as(carol, () => publish.requestPostPublish({ postId: post.expire, expectedVersion: 1 }));
    backdate(request.id);

    const [listed] = await as(alice, () => publish.listPublishRequests({ workspaceId: WA, postId: post.expire }));
    expect(listed).toMatchObject({ status: "pending", displayStatus: "expired" });
    expect(await codeOf(as(alice, () => publish.approvePublishRequest({ requestId: request.id, expectedPostVersion: 1 })))).toBe("request_expired");
    expect(await codeOf(as(alice, () => publish.rejectPublishRequest({ requestId: request.id })))).toBe("request_expired");
    // The database refuses as well, independently of the data-layer pre-check.
    const direct = await alice.client.rpc("approve_publish_request", { p_request_id: request.id, p_expected_post_version: 1 });
    expect(direct.error?.code).toBe("CP410");
    expect(postState(post.expire)).toMatchObject({ status: "draft", published: false });

    // A new request replaces the expired one, which is closed as expired.
    const fresh = await as(carol, () => publish.requestPostPublish({ postId: post.expire, expectedVersion: 1 }));
    expect(fresh.id).not.toBe(request.id);
    expect(events(request.id)).toEqual(["requested", "cancelled:expired"]);

    // An expired request can also be closed explicitly.
    const other = await as(carol, () => publish.requestPostPublish({ postId: post.expireCancel, expectedVersion: 1 }));
    backdate(other.id);
    expect(await as(carol, () => publish.cancelPublishRequest({ requestId: other.id }))).toMatchObject({ status: "cancelled", cancelReason: "expired" });
  });

  it("a post changed before approval cannot be published with the old request", async () => {
    const request = await as(carol, () => publish.requestPostPublish({ postId: post.changed, expectedVersion: 1 }));
    await as(dan, () => updatePost({ postId: post.changed, expectedVersion: 1, title: "Bài changed", body: "Đã sửa sau yêu cầu", status: "draft", scheduledFor: null }));

    expect(events(request.id)).toEqual(["requested", "cancelled:post_changed"]);
    expect(await codeOf(as(alice, () => publish.approvePublishRequest({ requestId: request.id, expectedPostVersion: 1 })))).toBe("request_closed");
    expect(await codeOf(as(alice, () => publish.approvePublishRequest({ requestId: request.id, expectedPostVersion: 2 })))).toBe("request_closed");
    const direct = await alice.client.rpc("approve_publish_request", { p_request_id: request.id, p_expected_post_version: 1 });
    expect(direct.error?.code).toBe("CP410");
    expect(postState(post.changed)).toMatchObject({ status: "draft", version: 2, published: false });
  });

  it("an admin may approve their own request, as a separate explicit call", async () => {
    const request = await as(adam, () => publish.requestPostPublish({ postId: post.self, expectedVersion: 1 }));
    const published = await as(adam, () => publish.approvePublishRequest({ requestId: request.id, expectedPostVersion: 1 }));
    expect(published.status).toBe("published");
    const detail = await as(adam, () => publish.getPublishRequest({ requestId: request.id }));
    expect(detail?.request.requestedBy).toBe(adam.id);
    expect(detail?.request.decidedBy).toBe(adam.id);
  });
});

// ---------------------------------------------------------------------------
// 2. Privilege escalation attempts
// ---------------------------------------------------------------------------

describe("bypass attempts", () => {
  it("a member cannot approve or reject, not even their own request", async () => {
    const request = await as(carol, () => publish.requestPostPublish({ postId: post.replay, expectedVersion: 1 }));
    expect(await codeOf(as(carol, () => publish.approvePublishRequest({ requestId: request.id, expectedPostVersion: 1 })))).toBe("forbidden");
    expect(await codeOf(as(carol, () => publish.rejectPublishRequest({ requestId: request.id })))).toBe("forbidden");
    // Directly through PostgREST, skipping the data-layer pre-check: the database refuses.
    const direct = await carol.client.rpc("approve_publish_request", { p_request_id: request.id, p_expected_post_version: 1 });
    expect(direct.error?.code).toBe("42501");
    expect(postState(post.replay).status).toBe("draft");
  });

  it("an outsider cannot see or act on the workspace's requests", async () => {
    const [request] = await as(alice, () => publish.listPublishRequests({ workspaceId: WA, postId: post.replay }));
    expect(await as(bob, () => publish.listPublishRequests({ workspaceId: WA }))).toEqual([]);
    expect(await as(bob, () => publish.getPublishRequest({ requestId: request!.id }))).toBeNull();
    expect(await codeOf(as(bob, () => publish.approvePublishRequest({ requestId: request!.id, expectedPostVersion: 1 })))).toBe("not_found");
    expect(await codeOf(as(bob, () => publish.cancelPublishRequest({ requestId: request!.id })))).toBe("not_found");
    for (const [fn, args] of [
      ["approve_publish_request", { p_request_id: request!.id, p_expected_post_version: 1 }],
      ["reject_publish_request", { p_request_id: request!.id }],
      ["cancel_publish_request", { p_request_id: request!.id }],
    ] as const) {
      const { error } = await bob.client.rpc(fn, args as never);
      expect(error?.code, fn).toBe("CP404");
    }
    const { data: events } = await bob.client.from("content_publish_request_events").select("id").eq("workspace_id", WA);
    expect(events).toEqual([]);
    expect(await codeOf(as(bob, () => publish.requestPostPublish({ postId: post.direct, expectedVersion: 1 })))).toBe("not_found");
    // Alice (owner of WA) is an outsider to WB.
    const requestB = await as(bob, () => publish.requestPostPublish({ postId: POST_B, expectedVersion: 1 }));
    expect(await codeOf(as(alice, () => publish.approvePublishRequest({ requestId: requestB.id, expectedPostVersion: 1 })))).toBe("not_found");
  });

  it("INSERT or UPDATE straight to published is refused by the database", async () => {
    const insert = await alice.client
      .from("content_posts")
      .insert({ workspace_id: WA, project_id: PA, title: "Đăng thẳng", status: "published" } as never);
    expect(insert.error?.code).toBe("42501");
    const insertWithTime = await alice.client
      .from("content_posts")
      .insert({ workspace_id: WA, project_id: PA, title: "Đăng thẳng", status: "published", published_at: new Date().toISOString() } as never);
    expect(insertWithTime.error?.code).toBe("42501");
    const update = await alice.client.from("content_posts").update({ status: "published" } as never).eq("id", post.direct);
    expect(update.error?.code).toBe("42501");
    const rpc = await alice.client.rpc("update_content_post", {
      p_post_id: post.direct, p_expected_version: 1, p_title: "Bài direct", p_body: "Nội dung direct", p_status: "published" as never, p_scheduled_for: null,
    });
    expect(rpc.error?.code).toBe("42501");
    const forgeRequest = await alice.client.from("content_publish_requests").insert({
      workspace_id: WA, post_id: post.direct, post_version: 1, request_source: "user", status: "approved", decided_by: alice.id,
    } as never);
    expect(forgeRequest.error?.code).toBe("42501");
    const [pending] = await as(alice, () => publish.listPublishRequests({ workspaceId: WA, postId: post.replay }));
    const forgeDecision = await alice.client
      .from("content_publish_requests")
      .update({ status: "approved", decided_by: alice.id } as never)
      .eq("id", pending!.id);
    expect(forgeDecision.error?.code).toBe("42501");
    const forgeEvent = await alice.client.from("content_publish_request_events").insert({
      workspace_id: WA, request_id: pending!.id, post_id: post.direct, post_version: 1, event: "published",
    } as never);
    expect(forgeEvent.error?.code).toBe("42501");
    expect(postState(post.direct)).toMatchObject({ status: "draft", published: false });
    expect(Number(psql(`select count(*) from public.content_posts where workspace_id = '${WA}' and title = 'Đăng thẳng'`))).toBe(0);
  });

  it("the AI agent marker header blocks approve/reject even with an owner session", async () => {
    const agentAlice = await agentClientOf(alice);
    const agentCarol = await agentClientOf(carol);

    // The agent may only file agent-marked requests.
    const disguised = await agentCarol.rpc("request_post_publish", { p_post_id: post.agent, p_expected_version: 1, p_source: "user" });
    expect(disguised.error?.code).toBe("42501");
    const turn = randomUUID();
    const filed = await agentCarol.rpc("request_post_publish", { p_post_id: post.agent, p_expected_version: 1, p_source: "agent", p_agent_turn_id: turn });
    expect(filed.error).toBeNull();
    expect(filed.data).toMatchObject({ status: "pending", request_source: "agent", agent_turn_id: turn, requested_by: carol.id });
    const requestId = filed.data!.id;

    const approve = await agentAlice.rpc("approve_publish_request", { p_request_id: requestId, p_expected_post_version: 1 });
    expect(approve.error?.code).toBe("42501");
    const reject = await agentAlice.rpc("reject_publish_request", { p_request_id: requestId });
    expect(reject.error?.code).toBe("42501");
    // Through the data layer with the agent client as well.
    expect(
      await codeOf(als.run(agentAlice, () => publish.approvePublishRequest({ requestId, expectedPostVersion: 1 }))),
    ).toBe("forbidden");
    expect(postState(post.agent)).toMatchObject({ status: "draft", published: false });
    expect(events(requestId)).toEqual(["requested"]);

    // The human owner then decides explicitly.
    await as(alice, () => publish.approvePublishRequest({ requestId, expectedPostVersion: 1 }));
    const detail = await as(alice, () => publish.getPublishRequest({ requestId }));
    expect(detail?.events.map((e) => `${e.event}:${e.actorSource}`)).toEqual(["requested:agent", "approved:user", "published:user"]);
  });

  it("re-approving, re-rejecting or cancelling a decided request is refused", async () => {
    const [request] = await as(alice, () => publish.listPublishRequests({ workspaceId: WA, postId: post.approve }));
    expect(request!.status).toBe("approved");
    expect(await codeOf(as(alice, () => publish.approvePublishRequest({ requestId: request!.id, expectedPostVersion: 1 })))).toBe("request_closed");
    expect(await codeOf(as(adam, () => publish.rejectPublishRequest({ requestId: request!.id })))).toBe("request_closed");
    expect(await codeOf(as(alice, () => publish.cancelPublishRequest({ requestId: request!.id })))).toBe("request_closed");
    for (const [fn, args] of [
      ["approve_publish_request", { p_request_id: request!.id, p_expected_post_version: 1 }],
      ["reject_publish_request", { p_request_id: request!.id }],
      ["cancel_publish_request", { p_request_id: request!.id }],
    ] as const) {
      const { error } = await alice.client.rpc(fn, args as never);
      expect(error?.code, fn).toBe("CP410");
    }
    expect(events(request!.id)).toEqual(["requested", "approved", "published"]);
    expect(postState(post.approve).version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Real concurrency: two clients, forced to race on the post's row lock
// ---------------------------------------------------------------------------

describe("concurrency (two clients at the same time)", () => {
  it("owner and admin approve the same request: exactly one wins", async () => {
    const request = await as(carol, () => publish.requestPostPublish({ postId: post.raceApprove, expectedVersion: 1 }));
    const lock = await holdPostLock(post.raceApprove, 1500);

    const started = Date.now();
    const racing = Promise.all([
      settle(as(alice, () => publish.approvePublishRequest({ requestId: request.id, expectedPostVersion: 1 }))),
      settle(as(adam, () => publish.approvePublishRequest({ requestId: request.id, expectedPostVersion: 1 }))),
    ]);
    await waitForWaiters(2); // both approvals are blocked inside the database
    const results = await racing;
    await lock.released;

    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok) as { ok: false; code: string };
    console.info(`[race two approvers] loser code: ${loser.code}`);
    expect(["version_conflict", "request_closed"]).toContain(loser.code);

    expect(postState(post.raceApprove)).toMatchObject({ status: "published", version: 2, body: "Nội dung raceApprove" });
    expect(events(request.id)).toEqual(["requested", "approved", "published"]);
    expect(Number(psql(`select count(*) from public.content_post_versions where post_id = '${post.raceApprove}' and status = 'published'`))).toBe(1);
  });

  // Postgres queues row-lock waiters in arrival order: the first caller queued wins
  // once the lock is released. Both orders are tested, so both outcomes are covered.
  it.each([
    ["approval queued first", "approval"],
    ["edit queued first", "edit"],
  ] as const)("approval while someone edits the post (%s): one wins, never a mismatched version", async (_label, first) => {
    const postId = first === "approval" ? post.raceEdit : post.raceEdit2;
    const request = await as(carol, () => publish.requestPostPublish({ postId, expectedVersion: 1 }));
    const lock = await holdPostLock(postId, 1500);

    const approve = () => settle(as(alice, () => publish.approvePublishRequest({ requestId: request.id, expectedPostVersion: 1 })));
    const edit = () =>
      settle(as(dan, () => updatePost({ postId, expectedVersion: 1, title: "Bài sửa", body: "Sửa đồng thời", status: "draft", scheduledFor: null })));
    let approval: Awaited<ReturnType<typeof approve>>;
    let edited: Awaited<ReturnType<typeof edit>>;
    if (first === "approval") {
      const a = approve();
      await waitForWaiters(1);
      const e = edit();
      await waitForWaiters(2);
      [approval, edited] = await Promise.all([a, e]);
    } else {
      const e = edit();
      await waitForWaiters(1);
      const a = approve();
      await waitForWaiters(2);
      [edited, approval] = await Promise.all([e, a]);
    }
    await lock.released;

    expect([approval.ok, edited.ok].filter(Boolean)).toHaveLength(1);
    const state = postState(postId);
    if (first === "approval") {
      // Published exactly the requested content; the edit lost.
      expect(approval.ok).toBe(true);
      expect(state).toMatchObject({ status: "published", version: 2, body: "Nội dung raceEdit" });
      expect(edited).toMatchObject({ ok: false });
      expect(["version_conflict", "post_published"]).toContain((edited as { code: string }).code);
      expect(events(request.id)).toEqual(["requested", "approved", "published"]);
    } else {
      // The edit won: nothing published, the request was cancelled because the post changed.
      expect(edited.ok).toBe(true);
      expect(state).toMatchObject({ status: "draft", version: 2, published: false, body: "Sửa đồng thời" });
      expect(["version_conflict", "request_closed"]).toContain((approval as { code: string }).code);
      expect(events(request.id)).toEqual(["requested", "cancelled:post_changed"]);
    }
    console.info(`[race approve vs edit, ${first} first] loser: ${JSON.stringify(approval.ok ? edited : approval)}`);
  });

  it("two members request publishing of the same post: one pending request only", async () => {
    const lock = await holdPostLock(post.raceRequest, 1500);
    const racing = Promise.all([
      settle(as(carol, () => publish.requestPostPublish({ postId: post.raceRequest, expectedVersion: 1 }))),
      settle(as(dan, () => publish.requestPostPublish({ postId: post.raceRequest, expectedVersion: 1 }))),
    ]);
    await waitForWaiters(2);
    const results = await racing;
    await lock.released;

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((results.find((r) => !r.ok) as { code: string }).code).toBe("request_pending_exists");
    expect(Number(psql(`select count(*) from public.content_publish_requests where post_id = '${post.raceRequest}'`))).toBe(1);
    expect(Number(psql(`select count(*) from public.content_publish_request_events where post_id = '${post.raceRequest}'`))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Global invariants after all scenarios
// ---------------------------------------------------------------------------

describe("invariants", () => {
  it("every published post went through exactly one approval of the version it was at", () => {
    const rows = psql(
      `select p.id || '|' || p.version || '|' ||
              (select count(*) from public.content_publish_requests r
                where r.post_id = p.id and r.status = 'approved' and r.post_version = p.version - 1) || '|' ||
              (select count(*) from public.content_publish_request_events e
                where e.post_id = p.id and e.event = 'published')
         from public.content_posts p where p.workspace_id in ('${WA}', '${WB}') and p.status = 'published'`,
    )
      .split("\n")
      .filter(Boolean);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      const [, , approvals, publishedEvents] = row.split("|");
      expect(approvals, row).toBe("1");
      expect(publishedEvents, row).toBe("1");
    }
  });

  it("at most one pending request per post, and every request has a 'requested' event", () => {
    expect(
      psql(`select count(*) from (select post_id from public.content_publish_requests where status = 'pending' group by post_id having count(*) > 1) d`),
    ).toBe("0");
    expect(
      psql(`select count(*) from public.content_publish_requests r where r.workspace_id in ('${WA}', '${WB}')
              and not exists (select 1 from public.content_publish_request_events e where e.request_id = r.id and e.event = 'requested')`),
    ).toBe("0");
    expect(
      psql(`select count(*) from public.content_publish_requests r where r.workspace_id in ('${WA}', '${WB}') and r.status <> 'pending'
              and not exists (select 1 from public.content_publish_request_events e where e.request_id = r.id and e.event::text = r.status::text)`),
    ).toBe("0");
  });
});
