import "server-only";

import type { CurrentUser } from "@/lib/auth/dal";
import {
  CONTENT_ERROR_MESSAGES,
  ContentError,
  type ContentErrorCode,
  contentFieldErrors,
  toContentError,
} from "@/lib/content/errors";
import { type ContentPost, createPost, getPost, listPosts, patchPost } from "@/lib/content/posts";
import { getProject, listProjects } from "@/lib/content/projects";
import { uuidSchema } from "@/lib/validation/content";
import { getMyWorkspace } from "@/lib/workspaces/queries";
import type { WorkspaceRole } from "@/types/database";

import {
  type AgentToolArgs,
  type AgentToolKind,
  type AgentToolName,
  agentToolArgs,
  agentToolDefinition,
} from "./tools";

/**
 * Executes agent tool calls with the signed-in user's permissions.
 *
 * Security model (holds even if the model is manipulated by prompt injection):
 *  - The workspace comes from an AgentToolContext created from the authenticated
 *    user and a membership check; no tool accepts a workspace id.
 *  - Every project/post id is checked to belong to that workspace before use.
 *  - All data access goes through src/lib/content, i.e. the user's Supabase
 *    session under RLS (never the service-role key).
 *  - Arguments are validated with strict Zod schemas (unknown keys rejected).
 *  - create_post always creates drafts; update_post edits drafts only, changes
 *    only the requested fields, requires expected_version and makes exactly one
 *    write attempt (a version conflict is reported, never retried).
 *  - Every write is recorded with change source "agent".
 */

// ---------------------------------------------------------------------------
// Context: the authenticated workspace scope
// ---------------------------------------------------------------------------

declare const contextBrand: unique symbol;

/** Created only by createAgentToolContext (the brand prevents hand-made contexts). */
export type AgentToolContext = Readonly<{
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}> & { readonly [contextBrand]: true };

/**
 * Locks the agent to one workspace the signed-in user belongs to. The id comes
 * from the authenticated request (route), never from the model.
 */
export async function createAgentToolContext(user: CurrentUser, workspaceId: unknown): Promise<AgentToolContext> {
  const parsed = uuidSchema.safeParse(workspaceId);
  if (!parsed.success) throw new ContentError("not_found");
  const workspace = await getMyWorkspace(user, parsed.data);
  if (!workspace) throw new ContentError("not_found");
  return Object.freeze({ workspaceId: workspace.id, userId: user.id, role: workspace.role }) as AgentToolContext;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type AgentToolErrorCode = ContentErrorCode | "not_draft" | "unknown_tool";

const AGENT_ERROR_MESSAGES: Partial<Record<AgentToolErrorCode, string>> = {
  not_draft: "Trợ lý AI chỉ được sửa bài viết ở trạng thái Bản nháp.",
  unknown_tool: "Công cụ không tồn tại.",
  version_conflict:
    "Bài viết đã thay đổi sau khi được đọc. Không ghi đè: hãy đọc lại bài viết và hỏi người dùng trước khi sửa tiếp.",
};

/** What a tool did, for the chat UI and (later) the agent_actions log. Never contains post bodies. */
export type AgentToolEffect = {
  kind: AgentToolKind;
  projectId?: string;
  postId?: string;
  versionBefore?: number;
  versionAfter?: number;
  /** Changed fields of an update (names only). */
  fields?: ("title" | "body" | "scheduled_for")[];
};

export type AgentToolResult =
  | { ok: true; tool: AgentToolName; data: unknown; effect: AgentToolEffect }
  | {
      ok: false;
      tool: string;
      code: AgentToolErrorCode;
      error: string;
      fieldErrors?: Partial<Record<string, string>>;
      effect?: AgentToolEffect;
    };

function failure(
  tool: string,
  code: AgentToolErrorCode,
  extra: { fieldErrors?: Partial<Record<string, string>>; effect?: AgentToolEffect } = {},
): AgentToolResult {
  const error = AGENT_ERROR_MESSAGES[code] ?? CONTENT_ERROR_MESSAGES[code as ContentErrorCode];
  return { ok: false, tool, code, error, ...extra };
}

// ---------------------------------------------------------------------------
// Data shapes returned to the model (snake_case, no internal ids of users)
// ---------------------------------------------------------------------------

function postForModel(post: ContentPost, { withBody }: { withBody: boolean }) {
  return {
    id: post.id,
    project_id: post.projectId,
    title: post.title,
    ...(withBody ? { body: post.body } : {}),
    status: post.status,
    scheduled_for: post.scheduledFor,
    version: post.version,
    archived: post.archivedAt !== null,
    updated_at: post.updatedAt,
  };
}

/** Loads a project and makes sure it belongs to the context workspace. */
async function projectInScope(ctx: AgentToolContext, projectId: string) {
  const project = await getProject({ projectId });
  if (!project || project.workspaceId !== ctx.workspaceId) throw new ContentError("not_found");
  return project;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

type Handler<K extends AgentToolName> = (
  ctx: AgentToolContext,
  args: AgentToolArgs[K],
) => Promise<{ data: unknown; effect: AgentToolEffect }>;

const handlers: { [K in AgentToolName]: Handler<K> } = {
  async list_projects(ctx) {
    const projects = await listProjects({ workspaceId: ctx.workspaceId });
    return {
      data: { projects: projects.map((p) => ({ id: p.id, name: p.name, description: p.description })) },
      effect: { kind: "read" },
    };
  },

  async list_posts(ctx, args) {
    const project = await projectInScope(ctx, args.project_id);
    const posts = await listPosts({ projectId: project.id, ...(args.status ? { status: args.status } : {}) });
    return {
      data: {
        project: { id: project.id, name: project.name },
        posts: posts.map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          scheduled_for: p.scheduledFor,
          version: p.version,
          updated_at: p.updatedAt,
        })),
      },
      effect: { kind: "read", projectId: project.id },
    };
  },

  async get_post(ctx, args) {
    const post = await getPost({ postId: args.post_id });
    if (!post || post.workspaceId !== ctx.workspaceId) throw new ContentError("not_found");
    return {
      data: { post: postForModel(post, { withBody: true }) },
      effect: { kind: "read", projectId: post.projectId, postId: post.id, versionAfter: post.version },
    };
  },

  async create_post(ctx, args) {
    const project = await projectInScope(ctx, args.project_id);
    if (project.archivedAt !== null) throw new ContentError("archived");
    const post = await createPost(
      {
        workspaceId: ctx.workspaceId,
        projectId: project.id,
        title: args.title,
        body: args.body,
        status: "draft",
        scheduledFor: args.scheduled_for ?? null,
      },
      { changeSource: "agent" },
    );
    return {
      data: { post: postForModel(post, { withBody: false }) },
      effect: { kind: "create", projectId: post.projectId, postId: post.id, versionAfter: post.version },
    };
  },

  async update_post(ctx, args) {
    const fields: NonNullable<AgentToolEffect["fields"]> = [];
    const patch: Record<string, unknown> = { postId: args.post_id, expectedVersion: args.expected_version };
    if (args.title != null) {
      patch.title = args.title;
      fields.push("title");
    }
    if (args.body != null) {
      patch.body = args.body;
      fields.push("body");
    }
    if (args.clear_schedule === true) {
      patch.scheduledFor = null;
      fields.push("scheduled_for");
    } else if (args.scheduled_for != null) {
      patch.scheduledFor = args.scheduled_for;
      fields.push("scheduled_for");
    }

    const post = await patchPost(patch, {
      changeSource: "agent",
      workspaceId: ctx.workspaceId,
      requireStatus: "draft",
    });
    return {
      data: { post: postForModel(post, { withBody: false }) },
      effect: {
        kind: "update",
        projectId: post.projectId,
        postId: post.id,
        versionBefore: args.expected_version,
        versionAfter: post.version,
        fields,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArguments(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== "string") return { ok: true, value: raw ?? {} };
  if (raw.length > 200_000) return { ok: false };
  try {
    return { ok: true, value: raw.trim() === "" ? {} : JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Runs one tool call. Never throws for expected failures: returns a result the
 * model and the UI can show. `rawArgs` is the model's JSON string (or an object).
 */
export async function executeAgentTool(
  ctx: AgentToolContext,
  name: string,
  rawArgs: unknown,
): Promise<AgentToolResult> {
  const definition = agentToolDefinition(name);
  if (!definition) return failure(name, "unknown_tool");
  const tool = definition.name;

  const json = parseArguments(rawArgs);
  if (!json.ok) return failure(tool, "invalid_input");
  const args = agentToolArgs[tool].safeParse(json.value);
  if (!args.success) return failure(tool, "invalid_input", { fieldErrors: contentFieldErrors(args.error) });

  try {
    const handler = handlers[tool] as Handler<typeof tool>;
    const { data, effect } = await handler(ctx, args.data as never);
    return { ok: true, tool, data, effect };
  } catch (error) {
    const contentError = toContentError(error);
    if (contentError.code === "unknown") {
      console.error("[agent tool] unexpected error", tool, error);
    }
    const code: AgentToolErrorCode = contentError.code === "not_allowed_status" ? "not_draft" : contentError.code;
    // Failed writes are still reported (with the target post, if known) so the UI can list them.
    const target = args.data as { post_id?: string; project_id?: string };
    const effect: AgentToolEffect | undefined =
      definition.kind === "read"
        ? undefined
        : { kind: definition.kind, postId: target.post_id, projectId: target.project_id };
    return failure(tool, code, { fieldErrors: contentError.fieldErrors, effect });
  }
}
