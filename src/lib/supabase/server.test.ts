import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/lib/env", () => ({ getSupabaseEnv: () => ({ url: "http://127.0.0.1:54321", key: "publishable-key" }) }));

import { AGENT_ACTOR_HEADER, createClient, currentActor, runAsAgent } from "./server";

/** Headers the created client would send (from the options passed to createServerClient). */
function headersOfLastClient(): Record<string, string> {
  const options = mocks.createServerClient.mock.calls.at(-1)![2] as { global?: { headers?: Record<string, string> } };
  return options.global?.headers ?? {};
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createServerClient.mockImplementation((_url: string, _key: string, options: unknown) => ({ options }));
});

describe("actor context", () => {
  it("outside runAsAgent the client acts as the user: no agent header", async () => {
    expect(currentActor()).toBe("user");
    await createClient();
    expect(headersOfLastClient()).toEqual({});
  });

  it("inside runAsAgent every client sends the agent marker header", async () => {
    await runAsAgent(async () => {
      expect(currentActor()).toBe("agent");
      await tick(1);
      await createClient();
      expect(headersOfLastClient()).toEqual({ [AGENT_ACTOR_HEADER]: "agent" });
    });
    expect(AGENT_ACTOR_HEADER).toBe("x-contentpilot-actor");
  });

  it("the scope ends with the call: afterwards the user acts again", async () => {
    await runAsAgent(async () => {
      await createClient();
    });
    expect(currentActor()).toBe("user");
    await createClient();
    expect(headersOfLastClient()).toEqual({});
  });

  it("concurrent requests never share the actor (interleaved agent turns and user actions)", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const asAgent = i % 2 === 0;
        const work = async () => {
          await tick((i * 7) % 5); // interleave across the event loop
          const client = (await createClient()) as unknown as { options: { global?: { headers?: Record<string, string> } } };
          await tick((i * 3) % 4);
          return { asAgent, headers: client.options.global?.headers ?? {}, actor: currentActor() };
        };
        return asAgent ? runAsAgent(work) : work();
      }),
    );
    for (const r of results) {
      expect(r.actor).toBe(r.asAgent ? "agent" : "user");
      expect(r.headers).toEqual(r.asAgent ? { [AGENT_ACTOR_HEADER]: "agent" } : {});
    }
  });

  it("every client is a new instance with its own headers object (nothing shared between requests)", async () => {
    await runAsAgent(() => createClient());
    await createClient();
    const [agentOptions, userOptions] = mocks.createServerClient.mock.calls.map((c) => c[2] as { global: { headers: object } });
    expect(agentOptions!.global.headers).not.toBe(userOptions!.global.headers);
    expect(userOptions!.global.headers).toEqual({});
  });

  it("an error inside the agent scope does not leak the scope", async () => {
    await expect(runAsAgent(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(currentActor()).toBe("user");
  });
});

describe("who may set the agent actor (source scan)", () => {
  const root = process.cwd();
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }
  const files = sources(join(root, "src"));

  it("only the /api/agent route calls runAsAgent", () => {
    const callers = files
      .filter((f) => !f.endsWith(join("lib", "supabase", "server.ts")))
      .filter((f) => /runAsAgent\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1));
    expect(callers).toEqual([join("src", "app", "api", "agent", "route.ts")]);
  });

  it("no code reads the actor from an incoming request header", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/headers\.get\(\s*["']x-contentpilot-actor/i);
      expect(text, file).not.toMatch(/headers\(\)[\s\S]{0,80}x-contentpilot-actor/i);
    }
  });
});
