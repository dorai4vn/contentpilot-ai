import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { AGENT_TOOLS, AGENT_TOOL_NAMES, agentToolArgs, agentToolDefinition, openAIFunctionTools } from "./tools";

type Schema = { [key: string]: unknown };

/** Collects every nested JSON-schema object (to check strict-mode rules everywhere). */
function walk(schema: Schema, visit: (s: Schema) => void) {
  visit(schema);
  for (const value of Object.values(schema)) {
    if (value && typeof value === "object" && !Array.isArray(value)) walk(value as Schema, visit);
  }
}

describe("tool catalogue", () => {
  it("has exactly the five M3 tools", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([...AGENT_TOOL_NAMES]);
    expect(AGENT_TOOL_NAMES).toEqual(["list_projects", "list_posts", "get_post", "create_post", "update_post"]);
  });

  it("classifies reads and writes", () => {
    expect(Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, t.kind]))).toEqual({
      list_projects: "read",
      list_posts: "read",
      get_post: "read",
      create_post: "create",
      update_post: "update",
    });
  });

  it("has Vietnamese labels for the UI", () => {
    for (const tool of AGENT_TOOLS) expect(tool.label).toMatch(/^(Đọc|Tạo|Cập nhật)/);
  });

  it("looks up definitions by name only", () => {
    expect(agentToolDefinition("get_post")?.name).toBe("get_post");
    expect(agentToolDefinition("delete_post")).toBeUndefined();
    expect(agentToolDefinition("__proto__")).toBeUndefined();
  });
});

describe("OpenAI function calling (strict mode) compatibility", () => {
  const tools = openAIFunctionTools();

  it("uses the Responses API function tool shape with strict mode", () => {
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.strict).toBe(true);
      expect(tool.name).toMatch(/^[a-z_]{1,64}$/);
      expect(tool.description?.length).toBeGreaterThan(20);
    }
  });

  it("every object lists all its properties as required and forbids extra ones", () => {
    for (const tool of tools) {
      walk(tool.parameters as Schema, (s) => {
        if (s.type === "object") {
          expect(s.additionalProperties, tool.name).toBe(false);
          expect([...(s.required as string[])].sort(), tool.name).toEqual(Object.keys(s.properties as Schema).sort());
        }
      });
    }
  });

  it("JSON schema properties match the Zod argument schemas", () => {
    for (const tool of AGENT_TOOLS) {
      const zodShape = agentToolArgs[tool.name].shape;
      expect(Object.keys((tool.parameters as Schema).properties as Schema).sort(), tool.name).toEqual(
        Object.keys(zodShape).sort(),
      );
    }
  });

  it("no tool lets the model choose a workspace, status, publication or deletion", () => {
    const text = JSON.stringify(tools.map((t) => t.parameters));
    expect(text).not.toMatch(/workspace/i);
    expect(text).not.toMatch(/"published"/);
    for (const name of ["create_post", "update_post"]) {
      const props = (agentToolDefinition(name)!.parameters as Schema).properties as Schema;
      expect(Object.keys(props), name).not.toContain("status");
      expect(Object.keys(props), name).not.toContain("workspace_id");
    }
    expect(tools.map((t) => t.name).join(",")).not.toMatch(/delete|publish|archive|status/);
  });
});

describe("argument schemas", () => {
  const PROJECT = "33333333-3333-4333-8333-333333333333";
  const POST = "44444444-4444-4444-8444-444444444444";
  const parse = (name: keyof typeof agentToolArgs, value: unknown) =>
    (agentToolArgs[name] as z.ZodType).safeParse(value);

  it("accept what strict-mode models send (nulls for unset values)", () => {
    expect(parse("list_projects", {}).success).toBe(true);
    expect(parse("list_posts", { project_id: PROJECT, status: null }).success).toBe(true);
    expect(parse("get_post", { post_id: POST }).success).toBe(true);
    expect(parse("create_post", { project_id: PROJECT, title: "T", body: "", scheduled_for: null }).success).toBe(true);
    expect(
      parse("update_post", {
        post_id: POST,
        expected_version: 3,
        title: null,
        body: "New",
        scheduled_for: null,
        clear_schedule: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["list_projects", { workspace_id: PROJECT }],
    ["list_posts", { project_id: PROJECT, status: "published" }],
    ["list_posts", { project_id: "nope", status: null }],
    ["get_post", { post_id: POST, workspace_id: PROJECT }],
    ["create_post", { project_id: PROJECT, title: "T", body: "", scheduled_for: null, status: "ready" }],
    ["create_post", { project_id: PROJECT, title: "  ", body: "", scheduled_for: null }],
    ["create_post", { project_id: PROJECT, title: "T", body: "", scheduled_for: "2026-12-01T09:00" }],
    ["update_post", { post_id: POST, title: "T" }],
    ["update_post", { post_id: POST, expected_version: 0, title: "T" }],
    ["update_post", { post_id: POST, expected_version: 3 }],
    ["update_post", { post_id: POST, expected_version: 3, title: null, body: null, scheduled_for: null, clear_schedule: false }],
    ["update_post", { post_id: POST, expected_version: 3, status: "ready", title: "T" }],
    ["update_post", { post_id: POST, expected_version: 3, scheduled_for: "2026-12-01T09:00:00Z", clear_schedule: true }],
  ] as const)("%s rejects %j", (name, value) => {
    expect(parse(name, value).success).toBe(false);
  });
});
