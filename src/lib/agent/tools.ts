import type { FunctionTool } from "openai/resources/responses/responses";
import { z } from "zod";

import {
  editablePostStatusSchema,
  expectedVersionSchema,
  postBodySchema,
  postTitleSchema,
  scheduledAtSchema,
  uuidSchema,
} from "@/lib/validation/content";

/**
 * The tools the M3 agent may call, as (1) strict Zod schemas that validate
 * whatever the model sends and (2) JSON schemas for OpenAI function calling in
 * strict mode (every property listed in `required`, optional values expressed
 * as `null`, no additional properties).
 *
 * Deliberately absent from every tool: workspace ids (the executor injects the
 * authenticated workspace), status changes, publishing, archiving and deletion
 * (risky actions are for M4, behind human approval).
 */

export const AGENT_TOOL_NAMES = ["list_projects", "list_posts", "get_post", "create_post", "update_post"] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export type AgentToolKind = "read" | "create" | "update";

// ---------------------------------------------------------------------------
// Argument schemas (what the model may send). null = "not provided".
// ---------------------------------------------------------------------------

const optionalStatus = editablePostStatusSchema.nullish();

export const agentToolArgs = {
  list_projects: z.strictObject({}),
  list_posts: z.strictObject({
    project_id: uuidSchema,
    status: optionalStatus,
  }),
  get_post: z.strictObject({
    post_id: uuidSchema,
  }),
  create_post: z.strictObject({
    project_id: uuidSchema,
    title: postTitleSchema,
    body: postBodySchema,
    scheduled_for: scheduledAtSchema.nullish(),
  }),
  update_post: z
    .strictObject({
      post_id: uuidSchema,
      expected_version: expectedVersionSchema,
      title: postTitleSchema.nullish(),
      body: postBodySchema.nullish(),
      scheduled_for: scheduledAtSchema.nullish(),
      clear_schedule: z.boolean().nullish(),
    })
    .refine((v) => !(v.clear_schedule === true && v.scheduled_for != null), {
      message: "Không thể vừa đặt lịch đăng mới vừa xóa lịch đăng.",
      path: ["clear_schedule"],
    })
    .refine((v) => v.title != null || v.body != null || v.scheduled_for != null || v.clear_schedule === true, {
      message: "Cần ít nhất một thay đổi (tiêu đề, nội dung hoặc lịch đăng).",
      path: ["form"],
    }),
} satisfies Record<AgentToolName, z.ZodType>;

export type AgentToolArgs = { [K in AgentToolName]: z.output<(typeof agentToolArgs)[K]> };

// ---------------------------------------------------------------------------
// Definitions shown to the model and the UI.
// ---------------------------------------------------------------------------

type JsonSchema = { [key: string]: unknown };

const uuid = (description: string): JsonSchema => ({ type: "string", format: "uuid", description });
const nullableString = (description: string): JsonSchema => ({ type: ["string", "null"], description });

function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export type AgentToolDefinition = {
  name: AgentToolName;
  kind: AgentToolKind;
  /** Vietnamese label for the "actions performed" cards in the chat UI. */
  label: string;
  /** Instructions for the model. */
  description: string;
  parameters: JsonSchema;
};

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "list_projects",
    kind: "read",
    label: "Đọc danh sách dự án",
    description: "List the active content projects of the current workspace (id, name, description).",
    parameters: objectSchema({}),
  },
  {
    name: "list_posts",
    kind: "read",
    label: "Đọc danh sách bài viết",
    description:
      "List the non-archived posts of a project in the current workspace (id, title, status, schedule, version). Bodies are not included; use get_post to read one.",
    parameters: objectSchema({
      project_id: uuid("Project id from list_projects."),
      status: { type: ["string", "null"], enum: ["draft", "ready", null], description: "Optional status filter; null for all." },
    }),
  },
  {
    name: "get_post",
    kind: "read",
    label: "Đọc nội dung bài viết",
    description:
      "Read one post including its body and its current version. Always call this before update_post and pass the returned version as expected_version.",
    parameters: objectSchema({ post_id: uuid("Post id.") }),
  },
  {
    name: "create_post",
    kind: "create",
    label: "Tạo bài viết",
    description:
      "Create a new post in a project of the current workspace. The post is always created as a draft. The project must not be archived.",
    parameters: objectSchema({
      project_id: uuid("Project id from list_projects."),
      title: { type: "string", description: "Title, 1-200 characters." },
      body: { type: "string", description: "Body text, up to 50,000 characters (may be empty)." },
      scheduled_for: nullableString(
        "Planned publication time as ISO 8601 with seconds and a UTC offset, e.g. 2026-12-01T09:00:00+07:00; null if not scheduled.",
      ),
    }),
  },
  {
    name: "update_post",
    kind: "update",
    label: "Cập nhật bài viết",
    description:
      "Change the title, body and/or planned publication time of a DRAFT post. Pass null for every field that must stay unchanged. expected_version must be the version returned by get_post; if the post changed meanwhile the update is rejected (version_conflict): do not retry, tell the user. Cannot change status, publish, archive or delete.",
    parameters: objectSchema({
      post_id: uuid("Post id."),
      expected_version: { type: "integer", description: "The version returned by get_post." },
      title: nullableString("New title (1-200 characters) or null to keep it."),
      body: nullableString("New full body text or null to keep it."),
      scheduled_for: nullableString(
        "New planned publication time (ISO 8601 with seconds and offset) or null to keep it.",
      ),
      clear_schedule: { type: ["boolean", "null"], description: "true to remove the planned publication time; otherwise null." },
    }),
  },
];

const TOOL_INDEX = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));

export function agentToolDefinition(name: string): AgentToolDefinition | undefined {
  return TOOL_INDEX.get(name as AgentToolName);
}

/** The tools in the OpenAI Responses API format (function calling, strict mode). */
export function openAIFunctionTools(): FunctionTool[] {
  return AGENT_TOOLS.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: true,
  }));
}
