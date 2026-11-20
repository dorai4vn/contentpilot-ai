import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Server Actions and the router are replaced: these tests only check what the
// components render (fields sent, controls offered), not the actions themselves.
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/_actions/content/posts", () => ({
  createPostAction: vi.fn(),
  updatePostAction: vi.fn(),
  setPostStatusAction: vi.fn(),
  archivePostAction: vi.fn(),
  restorePostAction: vi.fn(),
}));
vi.mock("@/app/_actions/content/projects", () => ({
  createProjectAction: vi.fn(),
  updateProjectAction: vi.fn(),
  archiveProjectAction: vi.fn(),
  restoreProjectAction: vi.fn(),
}));

import { ArchivePostButton, CreatePostForm, type EditablePost, PostEditor, StatusSwitch } from "./post-forms";
import { CreateProjectForm, ProjectCard, type ProjectView } from "./project-forms";
import { ScheduleField } from "./schedule-field";
import { StatusBadge } from "./ui";

const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";

const project: ProjectView = {
  id: PROJECT,
  workspaceId: WS,
  name: "Blog",
  description: "Company blog",
  archivedAt: null,
  updatedAt: "2026-11-20T10:00:00Z",
};

const post: EditablePost = {
  id: POST,
  workspaceId: WS,
  projectId: PROJECT,
  title: "  Spaced title  ",
  body: "\n  indented body\n",
  status: "draft",
  scheduledFor: "2026-12-01T02:00:00.123456+00:00",
  version: 7,
  archivedAt: null,
};

/** Names of all form fields in the markup, with their values. */
function fields(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  const doc = html.replace(/\n/g, " ");
  for (const match of doc.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
    const attrs = match[2]!;
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1];
    if (!name) continue;
    result[name] = /\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? "";
  }
  return result;
}

const decode = (value: string) =>
  value.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

describe("ProjectCard permissions", () => {
  it("members only get the link: no edit or archive controls", () => {
    const html = renderToStaticMarkup(<ProjectCard project={project} canManage={false} />);
    expect(html).toContain(`href="/w/${WS}/p/${PROJECT}"`);
    expect(html).not.toContain('data-testid="edit-project"');
    expect(html).not.toContain('data-testid="archive-project"');
    expect(html).not.toContain("<form");
  });

  it("owners/admins can edit and archive an active project", () => {
    const html = renderToStaticMarkup(<ProjectCard project={project} canManage />);
    expect(html).toContain('data-testid="edit-project"');
    expect(html).toContain('data-testid="archive-project"');
    expect(fields(html)).toEqual({ projectId: PROJECT });
  });

  it("an archived project offers restore but not edit", () => {
    const html = renderToStaticMarkup(<ProjectCard project={{ ...project, archivedAt: "2026-11-20T11:00:00Z" }} canManage />);
    expect(html).toContain('data-testid="restore-project"');
    expect(html).not.toContain('data-testid="edit-project"');
    expect(html).toContain("Archived");
  });

  it("nothing offers deletion", () => {
    const html = renderToStaticMarkup(<ProjectCard project={project} canManage />);
    expect(html.toLowerCase()).not.toContain("delete");
  });
});

describe("CreateProjectForm", () => {
  it("sends only workspaceId, name and description", () => {
    const html = renderToStaticMarkup(<CreateProjectForm workspaceId={WS} />);
    expect(fields(html)).toEqual({ workspaceId: WS, name: "", description: "" });
    expect(html).toContain('maxLength="100"');
  });
});

describe("CreatePostForm", () => {
  it("offers only draft and ready, and no server-managed fields", () => {
    const html = renderToStaticMarkup(<CreatePostForm workspaceId={WS} projectId={PROJECT} />);
    expect(Object.keys(fields(html)).sort()).toEqual(
      ["body", "projectId", "scheduledFor", "status", "title", "workspaceId"].sort(),
    );
    expect(html).toContain('<option value="draft"');
    expect(html).toContain('<option value="ready"');
    expect(html).not.toContain("published");
  });
});

describe("PostEditor", () => {
  it("sends the version it was rendered with and the stored values", () => {
    const html = renderToStaticMarkup(<PostEditor post={post} readOnly={false} />);
    const f = fields(html);
    expect(f.postId).toBe(POST);
    expect(f.expectedVersion).toBe("7");
    expect(f.status).toBe("draft");
    expect(decode(f.title!)).toBe("  Spaced title  ");
    // Untouched schedule is submitted exactly as stored (no precision loss).
    expect(f.scheduledFor).toBe("2026-12-01T02:00:00.123456+00:00");
    expect(html).toContain('data-testid="save-post"');
  });

  it("is read-only for archived posts: inputs disabled, no save button", () => {
    const html = renderToStaticMarkup(<PostEditor post={{ ...post, archivedAt: "2026-11-20T11:00:00Z" }} readOnly />);
    expect(html).toMatch(/id="post-title"[^>]*disabled=""/);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).not.toContain('data-testid="save-post"');
  });

  it("has no publish or delete control", () => {
    const html = renderToStaticMarkup(<PostEditor post={post} readOnly={false} />).toLowerCase();
    expect(html).not.toContain("publish");
    expect(html).not.toContain("delete");
  });
});

describe("StatusSwitch (regression: only the status is sent)", () => {
  it("draft -> ready sends postId, expectedVersion and status only", () => {
    const html = renderToStaticMarkup(<StatusSwitch post={post} />);
    expect(fields(html)).toEqual({ postId: POST, expectedVersion: "7", status: "ready" });
    expect(html).toContain("Mark as ready");
  });

  it("ready -> draft sends the draft status", () => {
    const html = renderToStaticMarkup(<StatusSwitch post={{ ...post, status: "ready" }} />);
    expect(fields(html)).toEqual({ postId: POST, expectedVersion: "7", status: "draft" });
    expect(html).toContain("Move back to draft");
  });
});

describe("ArchivePostButton", () => {
  it("archives with the expected version", () => {
    const html = renderToStaticMarkup(<ArchivePostButton post={post} projectArchived={false} />);
    expect(fields(html)).toEqual({ postId: POST, expectedVersion: "7" });
    expect(html).toContain('data-testid="archive-post"');
  });

  it("cannot restore while the project is archived", () => {
    const html = renderToStaticMarkup(
      <ArchivePostButton post={{ ...post, archivedAt: "2026-11-20T11:00:00Z" }} projectArchived />,
    );
    expect(html).toMatch(/data-testid="restore-post"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="restore-post"/);
    expect(html).toContain("Restore the project first");
  });
});

describe("ScheduleField", () => {
  it("before hydration: keeps the stored value in the hidden field, local input disabled and empty", () => {
    const html = renderToStaticMarkup(<ScheduleField id="s" initialIso="2026-12-01T02:00:00.123456+00:00" />);
    expect(fields(html)).toEqual({ scheduledFor: "2026-12-01T02:00:00.123456+00:00" });
    const localInput = /<input[^>]*type="datetime-local"[^>]*>/.exec(html)?.[0] ?? "";
    expect(localInput).toContain('disabled=""');
    expect(localInput).toContain('value=""');
  });

  it("not scheduled submits an empty value", () => {
    expect(fields(renderToStaticMarkup(<ScheduleField id="s" initialIso={null} />))).toEqual({ scheduledFor: "" });
  });
});

describe("StatusBadge", () => {
  it.each([
    ["draft", "Draft"],
    ["ready", "Ready"],
  ] as const)("labels %s", (status, label) => {
    expect(renderToStaticMarkup(<StatusBadge status={status} />)).toContain(`>${label}<`);
  });
});
