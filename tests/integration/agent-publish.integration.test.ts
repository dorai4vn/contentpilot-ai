/**
 * M4.6c: the AI agent proposes publishing, against a LOCAL Supabase stack.
 *
 * REAL: Supabase Auth, PostgREST, RLS, RPCs and triggers (incl. the agent marker
 * check in the database), the agent loop, executor, data layer, agent_actions
 * logger and the AsyncLocalStorage actor scope (runAsAgent / currentActor).
 * FAKE: only the language model (scripted). No OpenAI.
 * REPLACED: createClient() (it reads Next.js cookies). Like the real one, it
 * returns the user's client, and — only inside runAsAgent — a client of the same
 * user that sends the x-contentpilot-actor: agent header to PostgREST.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/types/database";

import { assertAuditInsertGrants } from "./audit-grants";
import { assertLocalTarget } from "./local-target";

const target = assertLocalTarget(process.env);

vi.mock("server-only", () => ({}));
const hoisted = vi.hoisted(() => ({ store: null as null | { getStore(): unknown } }));
vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/supabase/server")>();
  return {
    ...real,
    createClient: async () => {
      const session = hoisted.store?.getStore() as { client: unknown; agentClient: unknown } | undefined;
      if (!session) throw new Error("no acting user in this async context");
      return real.currentActor() === "agent" ? session.agentClient : session.client;
    },
  };
});

import { approvePublishRequest, rejectPublishRequest, requestPostPublish } from "@/lib/content/publish-requests";
import { createAgentToolContext } from "@/lib/agent/executor";
import type { AgentModel, AgentModelResponse } from "@/lib/agent/llm";
import { runAgent } from "@/lib/agent/run";
import { currentActor, runAsAgent } from "@/lib/supabase/server";

type Client = SupabaseClient<Database>;
type TestUser = { id: string; email: string; client: Client; agentClient: Client };

const als = new AsyncLocalStorage<{ client: Client; agentClient: Client }>();
hoisted.store = als;
const stamp = Date.now();
const PASSWORD = "integration-password-123";

function newClient(headers: Record<string, string> = {}): Client {
  return createSupabaseClient<Database>(target.supabaseUrl, target.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers },
  });
}

async function signUp(label: string): Promise<TestUser> {
  const client = newClient();
  const email = `it-agentpub-${label}-${stamp}@example.test`;
  const { data, error } = await client.auth.signUp({ email, password: PASSWORD });
  if (error || !data.user || !data.session) throw new Error(`sign-up failed for ${label}`);
  // Same user, separate client whose requests carry the agent marker (what the real
  // createClient builds inside runAsAgent).
  const agentClient = newClient({ "x-contentpilot-actor": "agent" });
  const signIn = await agentClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error) throw new Error(`agent sign-in failed for ${label}`);
  return { id: data.user.id, email, client, agentClient };
}

const as = <T>(user: TestUser, fn: () => Promise<T>): Promise<T> =>
  als.run({ client: user.client, agentClient: user.agentClient }, fn);

function psql(query: string): string {
  return execFileSync("psql", [target.dbUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();
}

async function must<T>(promise: PromiseLike<{ data: T; error: unknown }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as NonNullable<T>;
}

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
function scripted(steps: AgentModelResponse[]): AgentModel {
  return {
    async respond() {
      const step = steps.shift();
      if (!step) throw new Error("fake model: no more steps");
      return step;
    },
  };
}
const ask = [{ role: "user" as const, content: "Gửi yêu cầu xuất bản bài này lên Nội bộ" }];

/** One agent turn exactly like the route: membership check as the user, the turn as the agent. */
async function agentTurn(user: TestUser, workspaceId: string, steps: AgentModelResponse[]) {
  return as(user, async () => {
    const ctx = await createAgentToolContext({ id: user.id, email: user.email }, workspaceId);
    return runAsAgent(() => runAgent({ ctx, model: scripted(steps), messages: ask }));
  });
}

let owner: TestUser; // owner of WA
let member: TestUser; // member of WA
let outsider: TestUser; // owner of WB
const WA = randomUUID();
const WB = randomUUID();
const PA = randomUUID();
const posts = Object.fromEntries(
  ["main", "concurrentA", "concurrentB", "human", "stale", "foreign", "auditFail", "approveTry"].map((k) => [k, randomUUID()]),
) as Record<string, string>;
let DEST_A = "";
let DEST_B = "";

beforeAll(async () => {
  assertAuditInsertGrants(psql);
  [owner, member, outsider] = await Promise.all(["owner", "member", "outsider"].map(signUp));
  await must(owner.client.from("workspaces").insert({ id: WA, name: "IT agent publish A" }), "WA");
  await must(owner.client.from("workspace_members").insert({ workspace_id: WA, user_id: member.id, role: "member" }), "member");
  await must(owner.client.from("content_projects").insert({ id: PA, workspace_id: WA, name: "Blog" }), "project");
  await must(
    member.client.from("content_posts").insert(Object.entries(posts).map(([k, id]) => ({ id, workspace_id: WA, project_id: PA, title: `Bài ${k}`, body: "x" }))),
    "posts",
  );
  await must(outsider.client.from("workspaces").insert({ id: WB, name: "IT agent publish B" }), "WB");
  DEST_A = (await must(owner.client.from("publishing_destinations").select("id").eq("workspace_id", WA).single(), "dest A")).id;
  DEST_B = (await must(outsider.client.from("publishing_destinations").select("id").eq("workspace_id", WB).single(), "dest B")).id;
}, 60_000);

const requestOf = (postId: string) =>
  psql(`select coalesce(json_agg(json_build_object('id', id, 'status', status, 'source', request_source, 'turn', agent_turn_id,
          'by', requested_by, 'destination', destination_id, 'version', post_version))::text, '[]')
        from public.content_publish_requests where post_id = '${postId}'`);

describe("agent publish requests (real Supabase)", () => {
  it("the agent lists destinations, reads the post and files ONE pending request; nothing is published", async () => {
    const result = await agentTurn(member, WA, [
      tools(call("list_publish_destinations", {})),
      tools(call("get_post", { post_id: posts.main })),
      tools(call("request_publish", { post_id: posts.main, expected_version: 1, destination_id: DEST_A, reason: "Đã hoàn chỉnh" })),
      say("Đã gửi yêu cầu xuất bản phiên bản 1 lên đích Nội bộ; yêu cầu đang chờ duyệt."),
    ]);
    expect(result.stopReason).toBe("completed");
    expect(result.actions.map((a) => [a.tool, a.status])).toEqual([
      ["list_publish_destinations", "success"],
      ["get_post", "success"],
      ["request_publish", "success"],
    ]);
    expect(result.logging).toEqual({ recorded: 3, failed: 0 });

    const [req] = JSON.parse(requestOf(posts.main));
    expect(req).toMatchObject({ status: "pending", source: "agent", turn: result.turnId, by: member.id, destination: DEST_A, version: 1 });
    expect(psql(`select status from public.content_posts where id = '${posts.main}'`)).toBe("draft");

    // The audit row names the real request, the server's turn and the acting user.
    const log = psql(
      `select json_build_object('kind', kind, 'status', status, 'request', request_id, 'turn', turn_id, 'user', user_id, 'version', version_after)::text
         from public.agent_actions where tool = 'request_publish' and post_id = '${posts.main}'`,
    );
    expect(JSON.parse(log)).toEqual({ kind: "publish_request", status: "success", request: req.id, turn: result.turnId, user: member.id, version: 1 });
  });

  it("the agent cannot approve or reject (even in the owner's session); the owner approves as a separate human action", async () => {
    const [req] = JSON.parse(requestOf(posts.main));
    const attempt = await as(owner, () =>
      runAsAgent(async () => {
        const results = [];
        for (const fn of [
          () => approvePublishRequest({ requestId: req.id, expectedPostVersion: 1, expectedDestinationId: DEST_A }),
          () => rejectPublishRequest({ requestId: req.id }),
        ]) {
          try {
            await fn();
            results.push("ok");
          } catch (e) {
            results.push((e as { code?: string }).code);
          }
        }
        return results;
      }),
    );
    expect(attempt).toEqual(["forbidden", "forbidden"]);
    expect(psql(`select status from public.content_publish_requests where id = '${req.id}'`)).toBe("pending");

    // Outside the agent scope (a human Server Action), the owner approves.
    const published = await as(owner, () => approvePublishRequest({ requestId: req.id, expectedPostVersion: 1, expectedDestinationId: DEST_A }));
    expect(published.status).toBe("published");
  });

  it("concurrent agent turns and a human request never mix actor contexts", async () => {
    const [a, b, human] = await Promise.all([
      agentTurn(member, WA, [
        tools(call("get_post", { post_id: posts.concurrentA })),
        tools(call("request_publish", { post_id: posts.concurrentA, expected_version: 1, destination_id: DEST_A, reason: null })),
        say("ok"),
      ]),
      agentTurn(owner, WA, [
        tools(call("get_post", { post_id: posts.concurrentB })),
        tools(call("request_publish", { post_id: posts.concurrentB, expected_version: 1, destination_id: DEST_A, reason: null })),
        say("ok"),
      ]),
      // A human request at the same time (no agent scope): it would be refused by the
      // database (42501) if the agent header leaked into it.
      as(member, async () => {
        expect(currentActor()).toBe("user");
        return requestPostPublish({ postId: posts.human, expectedVersion: 1, destinationId: DEST_A }, { workspaceId: WA });
      }),
    ]);
    const [reqA] = JSON.parse(requestOf(posts.concurrentA));
    const [reqB] = JSON.parse(requestOf(posts.concurrentB));
    const [reqH] = JSON.parse(requestOf(posts.human));
    expect(reqA).toMatchObject({ source: "agent", turn: a.turnId, by: member.id });
    expect(reqB).toMatchObject({ source: "agent", turn: b.turnId, by: owner.id });
    expect(reqH).toMatchObject({ source: "user", turn: null, by: member.id });
    expect(human.requestSource).toBe("user");
    expect(a.turnId).not.toBe(b.turnId);
  });

  it("stale version, foreign destination and missing read are refused; nothing is created", async () => {
    const stale = await agentTurn(member, WA, [
      tools(call("get_post", { post_id: posts.stale })),
      tools(call("request_publish", { post_id: posts.stale, expected_version: 9, destination_id: DEST_A, reason: null })),
      say("…"),
    ]);
    expect(stale.actions[1]).toMatchObject({ status: "skipped", code: "stale_version" });

    const foreign = await agentTurn(member, WA, [
      tools(call("get_post", { post_id: posts.foreign })),
      tools(call("request_publish", { post_id: posts.foreign, expected_version: 1, destination_id: DEST_B, reason: null })),
      say("…"),
    ]);
    expect(foreign.actions[1]).toMatchObject({ status: "error", code: "not_found" });

    const unread = await agentTurn(member, WA, [
      tools(call("request_publish", { post_id: posts.stale, expected_version: 1, destination_id: DEST_A, reason: null })),
      say("…"),
    ]);
    expect(unread.actions[0]).toMatchObject({ status: "skipped", code: "read_required" });

    expect(JSON.parse(requestOf(posts.stale))).toEqual([]);
    expect(JSON.parse(requestOf(posts.foreign))).toEqual([]);
  });

  it("a forged audit row (claiming a request) is refused by the database", async () => {
    const [reqH] = JSON.parse(requestOf(posts.human));
    const { error } = await member.agentClient.from("agent_actions").insert({
      workspace_id: WA,
      turn_id: randomUUID(),
      tool: "request_publish",
      kind: "publish_request",
      status: "success",
      post_id: posts.human,
      version_after: 1,
      request_id: reqH.id,
    });
    expect(error?.code).toBe("42501");
  });

  it("a failed audit write after the request was created: one request, reported, not retried", async () => {
    const result = await as(member, async () => {
      const ctx = await createAgentToolContext({ id: member.id, email: member.email }, WA);
      return runAsAgent(() =>
        runAgent({
          ctx,
          model: scripted([
            tools(call("get_post", { post_id: posts.auditFail })),
            tools(call("request_publish", { post_id: posts.auditFail, expected_version: 1, destination_id: DEST_A, reason: null })),
            say("Đã gửi yêu cầu, đang chờ duyệt."),
          ]),
          messages: ask,
          log: async () => "failed",
        }),
      );
    });
    expect(result.actions[1]).toMatchObject({ status: "success", log: "failed" });
    expect(result.logging.failed).toBe(2);
    expect(JSON.parse(requestOf(posts.auditFail))).toHaveLength(1);
  });

  it("M3 tools still work in the agent scope: read, create and update a draft", async () => {
    const created = await agentTurn(member, WA, [
      tools(call("create_post", { project_id: PA, title: "Bài từ AI", body: "Mở đầu", scheduled_for: null })),
      say("ok"),
    ]);
    expect(created.actions[0]).toMatchObject({ tool: "create_post", status: "success" });
    const newId = created.actions[0]!.effect!.postId!;
    const updated = await agentTurn(member, WA, [
      tools(call("get_post", { post_id: newId })),
      tools(call("update_post", { post_id: newId, expected_version: 1, title: null, body: "Đã sửa", scheduled_for: null, clear_schedule: null })),
      say("ok"),
    ]);
    expect(updated.actions[1]).toMatchObject({ tool: "update_post", status: "success" });
    expect(psql(`select version || ':' || last_change_source || ':' || status from public.content_posts where id = '${newId}'`)).toBe("2:agent:draft");
  });
});
