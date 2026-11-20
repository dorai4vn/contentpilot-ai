/**
 * Integration test of the M3 AI agent against a LOCAL Supabase stack.
 *
 * REAL: Supabase Auth users (sign-up on the local stack), the auth DAL,
 * workspace membership checks, the content data layer, Postgres RLS and RPCs,
 * the tool executor, the agent loop and the agent_actions logger.
 * FAKE: only the language model (a scripted AgentModel); OpenAI is never called.
 * REPLACED: createClient() from src/lib/supabase/server.ts, which reads Next.js
 * cookies, returns a real supabase-js client signed in as the acting user.
 *
 * Run with `npm run test:integration` (refuses non-local targets).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/types/database";

import { assertLocalTarget } from "./local-target";

// ---------------------------------------------------------------------------
// Guard: refuse anything that is not a local stack (before any network use).
// ---------------------------------------------------------------------------

const target = assertLocalTarget(process.env);

vi.mock("server-only", () => ({}));
const acting = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => acting.client }));

import { createAgentToolContext } from "@/lib/agent/executor";
import type { AgentModel, AgentModelRequest, AgentModelResponse } from "@/lib/agent/llm";
import { AGENT_REPLIES, runAgent } from "@/lib/agent/run";

type Client = SupabaseClient<Database>;
type TestUser = { id: string; email: string; client: Client };

const PASSWORD = "integration-password-123";
const stamp = Date.now();

function newClient(): Client {
  return createSupabaseClient<Database>(target.supabaseUrl, target.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Real sign-up on the local Auth server (email confirmation is off locally). */
async function signUp(label: string): Promise<TestUser> {
  const client = newClient();
  const email = `it-${label}-${stamp}@example.test`;
  const { data, error } = await client.auth.signUp({ email, password: PASSWORD });
  if (error || !data.session || !data.user) throw new Error(`sign-up failed for ${label}: ${error?.message}`);
  return { id: data.user.id, email, client };
}

function actAs(user: TestUser) {
  acting.client = user.client;
}

/** Superuser SQL on the LOCAL database, only to simulate infrastructure failures. */
function psql(query: string): string {
  return execFileSync("psql", [target.dbUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
  }).trim();
}

// ---------------------------------------------------------------------------
// Scripted fake model
// ---------------------------------------------------------------------------

type Step = AgentModelResponse | ((request: AgentModelRequest) => Promise<AgentModelResponse> | AgentModelResponse);
let seq = 0;
const call = (name: string, args: unknown) => {
  seq += 1;
  return { callId: `call_${seq}`, name, arguments: JSON.stringify(args) };
};
const tools = (...calls: AgentModelResponse["toolCalls"]): AgentModelResponse => ({
  text: "",
  toolCalls: calls,
  outputItems: calls.map((c) => ({ type: "function_call", call_id: c.callId, name: c.name, arguments: c.arguments })),
});
const say = (text: string): AgentModelResponse => ({ text, toolCalls: [], outputItems: [] });
function scripted(steps: Step[]): { model: AgentModel; requests: AgentModelRequest[] } {
  const requests: AgentModelRequest[] = [];
  return {
    requests,
    model: {
      async respond(request) {
        requests.push(request);
        const step = steps.shift();
        if (!step) throw new Error("fake model: no more steps");
        return typeof step === "function" ? step(request) : step;
      },
    },
  };
}
/** Parsed tool outputs the model received in its last request, by call id. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool outputs are JSON of varying shape
function toolOutputs(requests: AgentModelRequest[]): Record<string, { ok: boolean; code?: string; data?: any }> {
  const last = requests.at(-1)!;
  return Object.fromEntries(
    last.input
      .filter((i) => i.type === "function_call_output")
      .map((i) => [(i as { callId: string }).callId, JSON.parse((i as { output: string }).output)]),
  );
}
const ask = (content: string) => [{ role: "user" as const, content }];

// ---------------------------------------------------------------------------
// Fixtures (created by real users through RLS)
// ---------------------------------------------------------------------------

let alice: TestUser; // owner of WA
let carol: TestUser; // member of WA
let bob: TestUser; // owner of WB, outsider to WA
const WA = randomUUID();
const WB = randomUUID();
const PA = randomUUID(); // project in WA
const PB = randomUUID(); // project in WB
const POST_DRAFT = randomUUID(); // WA, draft
const POST_READY = randomUUID(); // WA, ready
const POST_CONFLICT = randomUUID(); // WA, draft (conflict scenario)
const POST_B = randomUUID(); // WB
const SCHEDULE = "2026-12-05T03:04:05.123456+00:00";

/** Throws on a database error. Reads return their rows; inserts without select return nothing useful. */
async function must<T>(promise: PromiseLike<{ data: T; error: unknown }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as NonNullable<T>;
}

beforeAll(async () => {
  [alice, carol, bob] = [await signUp("alice"), await signUp("carol"), await signUp("bob")];

  await must(alice.client.from("workspaces").insert({ id: WA, name: "IT workspace A" }), "create WA");
  await must(
    alice.client.from("workspace_members").insert({ workspace_id: WA, user_id: carol.id, role: "member" }),
    "add carol",
  );
  await must(alice.client.from("content_projects").insert({ id: PA, workspace_id: WA, name: "Blog A" }), "project A");
  await must(
    alice.client.from("content_posts").insert([
      // Bulk insert: every row lists the same keys (PostgREST fills missing keys with NULL, not defaults).
      { id: POST_DRAFT, workspace_id: WA, project_id: PA, title: "Bài nháp A", body: "Nội dung gốc A", status: "draft", scheduled_for: SCHEDULE },
      { id: POST_READY, workspace_id: WA, project_id: PA, title: "Bài đã duyệt", body: "Đã sẵn sàng", status: "ready", scheduled_for: null },
      { id: POST_CONFLICT, workspace_id: WA, project_id: PA, title: "Bài xung đột", body: "Bản gốc", status: "draft", scheduled_for: null },
    ]),
    "posts A",
  );

  await must(bob.client.from("workspaces").insert({ id: WB, name: "IT workspace B" }), "create WB");
  await must(bob.client.from("content_projects").insert({ id: PB, workspace_id: WB, name: "Blog B" }), "project B");
  await must(
    bob.client.from("content_posts").insert({ id: POST_B, workspace_id: WB, project_id: PB, title: "Bí mật B", body: "SECRET-B-BODY" }),
    "post B",
  );
});

afterAll(() => {
  acting.client = null;
});

// ---------------------------------------------------------------------------

describe("local target guard", () => {
  it.each([
    [{ INTEGRATION_SUPABASE_URL: "https://abcd.supabase.co", INTEGRATION_SUPABASE_KEY: "x".repeat(30), LOCAL_DB_URL: target.dbUrl }],
    [{ INTEGRATION_SUPABASE_URL: target.supabaseUrl, INTEGRATION_SUPABASE_KEY: "x".repeat(30), LOCAL_DB_URL: "postgresql://u:p@db.abcd.supabase.co:5432/postgres" }],
    [{ INTEGRATION_SUPABASE_URL: "https://contentpilot.vercel.app", INTEGRATION_SUPABASE_KEY: "x".repeat(30), LOCAL_DB_URL: target.dbUrl }],
    [{ INTEGRATION_SUPABASE_URL: "http://localhost.evil.com", INTEGRATION_SUPABASE_KEY: "x".repeat(30), LOCAL_DB_URL: target.dbUrl }],
    [{ INTEGRATION_SUPABASE_URL: target.supabaseUrl, INTEGRATION_SUPABASE_KEY: "", LOCAL_DB_URL: target.dbUrl }],
  ])("refuses a non-local or incomplete target %#", (env) => {
    expect(() => assertLocalTarget(env)).toThrow(/Refusing to run/);
  });

  it("accepts the running local stack", () => {
    expect(target.supabaseUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
  });
});

describe("full chain: read → create → update, with history and agent_actions", () => {
  it("runs on real data under RLS and records exactly what happened", async () => {
    actAs(alice);
    const ctx = await createAgentToolContext({ id: alice.id, email: alice.email }, WA);
    let newPostId = "";
    const { model, requests } = scripted([
      tools(call("list_projects", {})),
      tools(call("list_posts", { project_id: PA, status: "draft" })),
      tools(call("get_post", { post_id: POST_DRAFT })),
      tools(
        call("create_post", {
          project_id: PA,
          title: "Bài nháp do AI tạo",
          body: "Mở đầu chi tiết",
          scheduled_for: "2026-12-01T09:00:00+07:00",
        }),
      ),
      (request) => {
        const created = JSON.parse(
          (request.input.filter((i) => i.type === "function_call_output").at(-1) as { output: string }).output,
        );
        newPostId = created.data.post.id;
        return tools(call("get_post", { post_id: newPostId }));
      },
      () =>
        tools(
          call("update_post", {
            post_id: newPostId,
            expected_version: 1,
            title: null,
            body: "Mở đầu ngắn gọn",
            scheduled_for: null,
            clear_schedule: null,
          }),
        ),
      say("Mình đã tạo và rút gọn bài nháp mới."),
    ]);

    const result = await runAgent({ ctx, model, messages: ask("Tạo bài nháp rồi rút gọn"), timeZone: "Asia/Ho_Chi_Minh" });

    // Loop outcome
    expect(result.stopReason).toBe("completed");
    expect(result.toolCalls).toBe(6);
    expect(result.writes).toBe(2);
    expect(result.actions.map((a) => [a.tool, a.status])).toEqual([
      ["list_projects", "success"],
      ["list_posts", "success"],
      ["get_post", "success"],
      ["create_post", "success"],
      ["get_post", "success"],
      ["update_post", "success"],
    ]);
    expect(result.logging).toEqual({ recorded: 6, failed: 0 });

    // Reads returned real rows (scoped to WA).
    const outs = toolOutputs(requests);
    expect(outs.call_1!.data.projects.map((p: { id: string }) => p.id)).toEqual([PA]);
    const listed = outs.call_2!.data.posts.map((p: { id: string }) => p.id);
    expect(listed).toEqual(expect.arrayContaining([POST_DRAFT, POST_CONFLICT]));
    expect(listed).not.toContain(POST_READY);
    expect(outs.call_3!.data.post).toMatchObject({
      id: POST_DRAFT,
      body: "Nội dung gốc A",
      version: 1,
      scheduled_for: SCHEDULE,
    });

    // The new post in the database (read back as alice, through RLS).
    const post = await must(
      alice.client.from("content_posts").select("*").eq("id", newPostId).single(),
      "read new post",
    );
    expect(post).toMatchObject({
      workspace_id: WA,
      project_id: PA,
      title: "Bài nháp do AI tạo",
      body: "Mở đầu ngắn gọn",
      status: "draft",
      version: 2,
      last_change_source: "agent",
      created_by: alice.id,
      updated_by: alice.id,
    });
    expect(new Date(post.scheduled_for!).toISOString()).toBe("2026-12-01T02:00:00.000Z");

    // History: two agent versions by alice, the update kept title and schedule.
    const versions = await must(
      alice.client
        .from("content_post_versions")
        .select("version, title, body, status, scheduled_for, change_source, changed_by")
        .eq("post_id", newPostId)
        .order("version"),
      "versions",
    );
    expect(versions).toHaveLength(2);
    for (const v of versions) expect(v).toMatchObject({ change_source: "agent", changed_by: alice.id, status: "draft" });
    expect(versions[0]).toMatchObject({ version: 1, body: "Mở đầu chi tiết" });
    expect(versions[1]).toMatchObject({ version: 2, body: "Mở đầu ngắn gọn", title: "Bài nháp do AI tạo" });
    expect(versions[1]!.scheduled_for).toBe(versions[0]!.scheduled_for);

    // agent_actions: one row per tool call, matching the server-observed outcome.
    const log = await must(
      alice.client
        .from("agent_actions")
        .select("tool, kind, status, error_code, project_id, post_id, version_before, version_after, fields, user_id, workspace_id")
        .eq("turn_id", result.turnId)
        .order("created_at"),
      "agent_actions",
    );
    expect(log).toHaveLength(6);
    for (const row of log) expect(row).toMatchObject({ user_id: alice.id, workspace_id: WA, status: "success", error_code: null });
    expect(log.map((r) => r.tool)).toEqual(["list_projects", "list_posts", "get_post", "create_post", "get_post", "update_post"]);
    expect(log[3]).toMatchObject({ kind: "create", post_id: newPostId, project_id: PA, version_after: 1 });
    expect(log[5]).toMatchObject({ kind: "update", post_id: newPostId, version_before: 1, version_after: 2, fields: ["body"] });

    // The draft that was only read is untouched.
    const original = await must(alice.client.from("content_posts").select("version, body").eq("id", POST_DRAFT).single(), "post A");
    expect(original).toEqual({ version: 1, body: "Nội dung gốc A" });
  });
});

describe("workspace isolation and RLS", () => {
  it("the agent context cannot be created for a workspace the user does not belong to", async () => {
    actAs(alice);
    await expect(createAgentToolContext({ id: alice.id, email: alice.email }, WB)).rejects.toMatchObject({ code: "not_found" });
  });

  it("tools cannot reach another workspace, even with known ids", async () => {
    actAs(alice);
    const ctx = await createAgentToolContext({ id: alice.id, email: alice.email }, WA);
    const { model, requests } = scripted([
      tools(call("get_post", { post_id: POST_B })),
      tools(call("list_posts", { project_id: PB, status: null })),
      tools(call("create_post", { project_id: PB, title: "Xâm nhập", body: "x", scheduled_for: null })),
      tools(call("get_post", { post_id: POST_B, workspace_id: WB })),
      say("Không truy cập được."),
    ]);
    const result = await runAgent({ ctx, model, messages: ask("Đọc bài của workspace khác") });

    expect(result.actions.map((a) => [a.tool, a.status, a.code])).toEqual([
      ["get_post", "error", "not_found"],
      ["list_posts", "error", "not_found"],
      ["create_post", "error", "not_found"],
      ["get_post", "error", "invalid_input"],
    ]);
    expect(JSON.stringify(requests.at(-1)!.input)).not.toContain("SECRET-B-BODY");

    const bPosts = await must(bob.client.from("content_posts").select("id, title, version").eq("workspace_id", WB), "WB posts");
    expect(bPosts).toEqual([{ id: POST_B, title: "Bí mật B", version: 1 }]);
    const bLog = await must(bob.client.from("agent_actions").select("id").eq("workspace_id", WB), "WB log");
    expect(bLog).toHaveLength(0);
  });

  it("agent_actions are visible to members only", async () => {
    const carolSees = await must(carol.client.from("agent_actions").select("id").eq("workspace_id", WA), "carol");
    const bobSees = await must(bob.client.from("agent_actions").select("id").eq("workspace_id", WA), "bob");
    expect(carolSees.length).toBeGreaterThan(0);
    expect(bobSees).toHaveLength(0);
  });

  it("an outsider cannot write into the log of another workspace", async () => {
    const { error } = await bob.client
      .from("agent_actions")
      .insert({ workspace_id: WA, turn_id: randomUUID(), tool: "list_projects", kind: "read", status: "success" });
    expect(error?.code).toBe("42501");
  });

  it("a member cannot log a fake successful agent write", async () => {
    const { error } = await carol.client.from("agent_actions").insert({
      workspace_id: WA,
      turn_id: randomUUID(),
      tool: "update_post",
      kind: "update",
      status: "success",
      post_id: POST_CONFLICT,
      version_after: 1,
    });
    expect(error?.code).toBe("42501");
  });
});

describe("version conflicts and non-draft posts: nothing is overwritten", () => {
  it("a concurrent human edit between read and write makes the agent stop, without retry", async () => {
    actAs(alice);
    const ctx = await createAgentToolContext({ id: alice.id, email: alice.email }, WA);
    const update = (expected: number) =>
      call("update_post", {
        post_id: POST_CONFLICT,
        expected_version: expected,
        title: "Tiêu đề của AI",
        body: null,
        scheduled_for: null,
        clear_schedule: null,
      });
    const { model } = scripted([
      tools(call("get_post", { post_id: POST_CONFLICT })),
      async () => {
        // Carol edits the post through the normal RPC while the agent is "thinking".
        await must(
          carol.client.rpc("update_content_post", {
            p_post_id: POST_CONFLICT,
            p_expected_version: 1,
            p_title: "Tiêu đề của Carol",
            p_body: "Carol đã sửa",
            p_status: "draft",
            p_scheduled_for: null,
          }),
          "carol edit",
        );
        return tools(update(1));
      },
      tools(call("get_post", { post_id: POST_CONFLICT })),
      tools(update(2)),
      say("Bài viết vừa được người khác sửa nên mình chưa cập nhật."),
    ]);
    const result = await runAgent({ ctx, model, messages: ask("Đổi tiêu đề bài xung đột") });

    expect(result.actions.map((a) => [a.tool, a.status, a.code])).toEqual([
      ["get_post", "success", undefined],
      ["update_post", "error", "version_conflict"],
      ["get_post", "success", undefined],
      ["update_post", "skipped", "conflict_no_retry"],
    ]);

    const post = await must(
      alice.client.from("content_posts").select("title, body, version, last_change_source").eq("id", POST_CONFLICT).single(),
      "conflict post",
    );
    expect(post).toEqual({ title: "Tiêu đề của Carol", body: "Carol đã sửa", version: 2, last_change_source: "user" });
    const agentVersions = await must(
      alice.client.from("content_post_versions").select("version").eq("post_id", POST_CONFLICT).eq("change_source", "agent"),
      "agent versions",
    );
    expect(agentVersions).toHaveLength(0);

    const log = await must(
      alice.client.from("agent_actions").select("tool, status, error_code, post_id").eq("turn_id", result.turnId).order("created_at"),
      "conflict log",
    );
    expect(log.map((r) => [r.tool, r.status, r.error_code, r.post_id])).toEqual([
      ["get_post", "success", null, POST_CONFLICT],
      ["update_post", "error", "version_conflict", POST_CONFLICT],
      ["get_post", "success", null, POST_CONFLICT],
      ["update_post", "skipped", "conflict_no_retry", POST_CONFLICT],
    ]);
  });

  it("a ready post cannot be edited by the agent", async () => {
    actAs(alice);
    const ctx = await createAgentToolContext({ id: alice.id, email: alice.email }, WA);
    const { model } = scripted([
      tools(call("get_post", { post_id: POST_READY })),
      tools(
        call("update_post", {
          post_id: POST_READY,
          expected_version: 1,
          title: "Sửa bài đã duyệt",
          body: null,
          scheduled_for: null,
          clear_schedule: null,
        }),
      ),
      say("Bài này không còn là bản nháp."),
    ]);
    const result = await runAgent({ ctx, model, messages: ask("Sửa bài đã duyệt") });
    expect(result.actions[1]).toMatchObject({ tool: "update_post", status: "error", code: "not_draft" });
    const post = await must(alice.client.from("content_posts").select("title, version").eq("id", POST_READY).single(), "ready");
    expect(post).toEqual({ title: "Bài đã duyệt", version: 1 });
  });
});

describe("logging failure does not change what the agent did", () => {
  it("a write succeeds even when agent_actions rejects the log row", async () => {
    actAs(alice);
    const ctx = await createAgentToolContext({ id: alice.id, email: alice.email }, WA);
    // Simulate an infrastructure failure on the LOCAL database only: the log
    // table refuses inserts (as if its migration were missing).
    psql("revoke insert on table public.agent_actions from authenticated");
    try {
      const { model } = scripted([
        tools(call("create_post", { project_id: PA, title: "Bài khi log hỏng", body: "Nội dung", scheduled_for: null })),
        say("Mình đã tạo bài nháp “Bài khi log hỏng”."),
      ]);
      const result = await runAgent({ ctx, model, messages: ask("Tạo bài") });

      expect(result.actions[0]).toMatchObject({ tool: "create_post", status: "success", log: "failed" });
      expect(result.logging).toEqual({ recorded: 0, failed: 1 });
      expect(result.stopReason).toBe("completed");
      expect(result.reply).toContain("Mình đã tạo bài nháp “Bài khi log hỏng”.");
      expect(result.reply).toContain(AGENT_REPLIES.logFailed);

      const postId = result.actions[0]!.effect!.postId!;
      const post = await must(alice.client.from("content_posts").select("title, last_change_source").eq("id", postId).single(), "post");
      expect(post).toEqual({ title: "Bài khi log hỏng", last_change_source: "agent" });
      const log = await must(alice.client.from("agent_actions").select("id").eq("turn_id", result.turnId), "log");
      expect(log).toHaveLength(0);
    } finally {
      psql(
        "grant insert (workspace_id, turn_id, tool, kind, status, error_code, project_id, post_id, version_before, version_after, fields) on table public.agent_actions to authenticated",
      );
    }
  });
});
