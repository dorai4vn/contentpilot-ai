import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server pages of the M4 approval UI rendered with mocked data. Checks what each
 * role is offered (controls are hints only: the database enforces every rule).
 */
vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  getPublishRequest: vi.fn(),
  listPublishRequests: vi.fn(),
  listPublishRequestsPage: vi.fn(),
  countPublishRequests: vi.fn(),
  getPost: vi.fn(),
  getPostHistory: vi.fn(),
  listPostSummariesByIds: vi.fn(),
  getProject: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  listDisplayNames: vi.fn(),
  listProjects: vi.fn(),
  actions: {
    requestPublishAction: vi.fn(),
    approvePublishAction: vi.fn(),
    rejectPublishAction: vi.fn(),
    cancelPublishAction: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/w/_lib/load", () => ({ loadWorkspace: m.loadWorkspace, routeId: (v: string) => v }));
vi.mock("@/lib/content/publish-requests", () => ({
  getPublishRequest: m.getPublishRequest,
  listPublishRequests: m.listPublishRequests,
  listPublishRequestsPage: m.listPublishRequestsPage,
  countPublishRequests: m.countPublishRequests,
}));
vi.mock("@/lib/content/posts", () => ({
  getPost: m.getPost,
  getPostHistory: m.getPostHistory,
  listPostSummariesByIds: m.listPostSummariesByIds,
}));
vi.mock("@/lib/content/projects", () => ({ getProject: m.getProject, listProjects: m.listProjects }));
vi.mock("@/lib/workspaces/queries", () => ({ listWorkspaceMembers: m.listWorkspaceMembers }));
vi.mock("@/lib/profiles/profiles", () => ({ listDisplayNames: m.listDisplayNames }));
vi.mock("@/app/_actions/content/publish", () => m.actions);
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

import ApprovalReviewPage from "./[workspaceId]/approvals/[requestId]/page";
import ApprovalsPage from "./[workspaceId]/approvals/page";
import WorkspacePage from "./[workspaceId]/page";
import PostEditorPage from "./[workspaceId]/posts/[postId]/page";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "55555555-5555-4555-8555-555555555555";
const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";
const REQUEST = "66666666-6666-4666-8666-666666666666";

const post = {
  id: POST,
  workspaceId: WS,
  projectId: PROJECT,
  title: "Ra mắt Trợ lý AI",
  body: "Nội dung hiện tại",
  status: "draft",
  scheduledFor: null,
  version: 3,
  lastChangeSource: "user",
  archivedAt: null,
  createdAt: "2026-11-18T10:00:00Z",
  updatedAt: "2026-11-20T10:00:00Z",
  createdBy: OTHER,
  updatedBy: OTHER,
};
const version3 = {
  id: "v3",
  postId: POST,
  version: 3,
  title: "Ra mắt Trợ lý AI",
  body: "Nội dung phiên bản 3 được xin duyệt",
  status: "draft",
  scheduledFor: null,
  archivedAt: null,
  changedBy: OTHER,
  changeSource: "user",
  createdAt: "2026-11-20T10:00:00Z",
};
const request = {
  id: REQUEST,
  workspaceId: WS,
  postId: POST,
  postVersion: 3,
  status: "pending",
  displayStatus: "pending",
  requestSource: "user",
  agentTurnId: null,
  reason: "Đã kiểm tra chính tả",
  requestedBy: OTHER,
  requestedAt: "2026-11-20T10:05:00Z",
  expiresAt: "2026-11-27T10:05:00Z",
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  cancelReason: null,
};

function asRole(role: "owner" | "admin" | "member") {
  m.loadWorkspace.mockResolvedValue({
    user: { id: ME, email: null },
    workspace: { id: WS, name: "WS", role, createdAt: "2026-11-01T00:00:00Z" },
    permissions: { manageProjects: role !== "member", editPosts: true },
  });
}

const reviewPage = async () =>
  renderToStaticMarkup(await ApprovalReviewPage({ params: Promise.resolve({ workspaceId: WS, requestId: REQUEST }) } as never));
const postPage = async () =>
  renderToStaticMarkup(await PostEditorPage({ params: Promise.resolve({ workspaceId: WS, postId: POST }) } as never));

beforeEach(() => {
  vi.clearAllMocks();
  asRole("owner");
  m.getPublishRequest.mockResolvedValue({
    request,
    events: [
      { id: "e1", requestId: REQUEST, postId: POST, postVersion: 3, event: "requested", cancelReason: null, actorId: OTHER, actorSource: "user", createdAt: "2026-11-20T10:05:00Z" },
    ],
  });
  m.getPost.mockResolvedValue(post);
  m.getPostHistory.mockResolvedValue([version3]);
  m.getProject.mockResolvedValue({ id: PROJECT, workspaceId: WS, name: "Blog", archivedAt: null });
  m.listWorkspaceMembers.mockResolvedValue([
    { userId: ME, role: "owner" },
    { userId: OTHER, role: "member" },
  ]);
  m.listPublishRequests.mockResolvedValue([]);
  m.listDisplayNames.mockResolvedValue(new Map([[OTHER, "Bình Trần"]]));
  m.listPublishRequestsPage.mockResolvedValue({ items: [], filter: "pending", page: 1, pageSize: 20, total: 0, totalPages: 1 });
  m.countPublishRequests.mockResolvedValue({ pending: 0, expired: 0, approved: 0, rejected: 0, cancelled: 0, all: 0 });
  m.listPostSummariesByIds.mockResolvedValue(new Map([[POST, post]]));
  m.listProjects.mockResolvedValue([]);
});

describe("review page", () => {
  it("shows everything needed before deciding: title, body of the requested version, version, requester, times", async () => {
    const markup = await reviewPage();
    expect(markup).toContain('data-testid="review-content-title">Ra mắt Trợ lý AI');
    expect(markup).toContain("Nội dung phiên bản 3 được xin duyệt");
    expect(markup).not.toContain("Nội dung hiện tại"); // the requested snapshot, not the live post
    expect(markup).toContain('data-testid="review-requested-version">Phiên bản 3');
    expect(markup).toContain('data-testid="review-requester">Bình Trần (Thành viên)');
    expect(markup).not.toMatch(/#[0-9a-f]{8}/);
    expect(markup).toContain('dateTime="2026-11-20T10:05:00Z"');
    expect(markup).toContain('dateTime="2026-11-27T10:05:00Z"');
    expect(markup).toContain("Đã kiểm tra chính tả");
    expect(markup).toContain('data-testid="audit-trail"');
  });

  it.each(["owner", "admin"] as const)("%s sees approve (step 1 only) and reject", async (role) => {
    asRole(role);
    const markup = await reviewPage();
    expect(markup).toContain('data-testid="approve-start"');
    expect(markup).toContain('data-testid="reject-form"');
    // Rendering the page never shows the confirm step nor calls an action.
    expect(markup).not.toContain('name="confirm"');
    for (const fn of Object.values(m.actions)) expect(fn).not.toHaveBeenCalled();
  });

  it("a member sees no approve or reject control", async () => {
    asRole("member");
    const markup = await reviewPage();
    expect(markup).not.toContain("approve-start");
    expect(markup).not.toContain("reject-form");
    expect(markup).toContain('data-testid="decision-not-allowed"');
  });

  it("the requester (a member) may cancel; another member may not", async () => {
    asRole("member");
    m.getPublishRequest.mockResolvedValue({ request: { ...request, requestedBy: ME }, events: [] });
    expect(await reviewPage()).toContain('data-testid="cancel-request-form"');
    m.getPublishRequest.mockResolvedValue({ request, events: [] });
    expect(await reviewPage()).not.toContain("cancel-request-form");
  });

  it("post changed after the request: marked invalid, no approval possible", async () => {
    m.getPublishRequest.mockResolvedValue({ request: { ...request, status: "cancelled", displayStatus: "cancelled", cancelReason: "post_changed", decidedAt: "2026-11-20T11:00:00Z" }, events: [] });
    m.getPost.mockResolvedValue({ ...post, version: 4 });
    const markup = await reviewPage();
    expect(markup).toContain('data-testid="review-stale"');
    expect(markup).toContain("mất hiệu lực");
    expect(markup).not.toContain("approve-start");
  });

  it("pending but the post moved on (defence in depth): no approval", async () => {
    m.getPost.mockResolvedValue({ ...post, version: 4 });
    const markup = await reviewPage();
    expect(markup).toContain('data-testid="review-stale"');
    expect(markup).not.toContain("approve-start");
  });

  it("expired: shown as Hết hạn, no approval", async () => {
    m.getPublishRequest.mockResolvedValue({ request: { ...request, displayStatus: "expired" }, events: [] });
    const markup = await reviewPage();
    expect(markup).toContain('data-testid="review-expired"');
    expect(markup).toContain("Hết hạn");
    expect(markup).not.toContain("approve-start");
  });

  it("approved / rejected: decision shown, no controls", async () => {
    m.getPublishRequest.mockResolvedValue({
      request: { ...request, status: "approved", displayStatus: "approved", decidedBy: ME, decidedAt: "2026-11-20T12:00:00Z" },
      events: [],
    });
    m.getPost.mockResolvedValue({ ...post, status: "published", version: 4 });
    let markup = await reviewPage();
    expect(markup).toContain('data-testid="review-approved"');
    expect(markup).not.toContain("approve-start");
    m.getPublishRequest.mockResolvedValue({
      request: { ...request, status: "rejected", displayStatus: "rejected", decidedBy: ME, decidedAt: "2026-11-20T12:00:00Z", decisionNote: "Sửa tiêu đề" },
      events: [],
    });
    m.getPost.mockResolvedValue(post);
    markup = await reviewPage();
    expect(markup).toContain("Sửa tiêu đề");
    expect(markup).not.toContain("approve-start");
  });

  it("without a display name only the role is shown; a deleted account is 'Người dùng đã xóa'", async () => {
    m.listDisplayNames.mockResolvedValue(new Map());
    m.getPublishRequest.mockResolvedValue({
      request: { ...request, status: "rejected", displayStatus: "rejected", decidedBy: null, decidedAt: "2026-11-20T12:00:00Z" },
      events: [
        { id: "e1", requestId: REQUEST, postId: POST, postVersion: 3, event: "requested", cancelReason: null, actorId: OTHER, actorSource: "user", createdAt: "2026-11-20T10:05:00Z" },
        { id: "e2", requestId: REQUEST, postId: POST, postVersion: 3, event: "rejected", cancelReason: null, actorId: null, actorSource: "user", createdAt: "2026-11-20T12:00:00Z" },
      ],
    });
    const markup = await reviewPage();
    expect(markup).toContain('data-testid="review-requester">Thành viên<');
    expect(markup).toContain("Người dùng đã xóa");
    expect(markup).not.toMatch(/#[0-9a-f]{8}|@example/);
  });

  it("a request of another workspace is a 404", async () => {
    m.getPublishRequest.mockResolvedValue({ request: { ...request, workspaceId: "99999999-9999-4999-8999-999999999999" }, events: [] });
    await expect(reviewPage()).rejects.toThrow("NEXT_NOT_FOUND");
    m.getPublishRequest.mockResolvedValue(null);
    await expect(reviewPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("approvals list", () => {
  const render = async (searchParams: Record<string, string>) =>
    renderToStaticMarkup(
      await ApprovalsPage({ params: Promise.resolve({ workspaceId: WS }), searchParams: Promise.resolve(searchParams) } as never),
    );

  it("shows one server page with exact tab counts and Vietnamese statuses", async () => {
    m.countPublishRequests.mockResolvedValue({ pending: 1, expired: 1, approved: 0, rejected: 0, cancelled: 1, all: 3 });
    m.listPublishRequestsPage.mockResolvedValue({
      items: [request, { ...request, id: "r2", displayStatus: "expired" }, { ...request, id: "r3", status: "cancelled", displayStatus: "cancelled", cancelReason: "post_changed" }],
      filter: "all",
      page: 1,
      pageSize: 20,
      total: 3,
      totalPages: 1,
    });
    const all = await render({ status: "all" });
    expect(m.listPublishRequestsPage).toHaveBeenCalledWith({ workspaceId: WS, filter: "all", page: 1, pageSize: 20 });
    for (const label of ["Chờ duyệt (1)", "Hết hạn (1)", "Đã hủy (1)", "Đã phê duyệt (0)", "Đã từ chối (0)", "Tất cả (3)"]) {
      expect(all).toContain(label);
    }
    expect(all).toContain('data-testid="approval-item-stale"');
    expect(all.match(/data-testid="approval-item"/g)).toHaveLength(3);
    expect(all).not.toContain("approve-start"); // the list itself offers no approve button
    expect(all).not.toContain("approvals-pagination");
  });

  it("passes filter and page from the URL and links pages keeping the filter", async () => {
    m.countPublishRequests.mockResolvedValue({ pending: 0, expired: 0, approved: 45, rejected: 0, cancelled: 0, all: 45 });
    m.listPublishRequestsPage.mockResolvedValue({
      items: [{ ...request, status: "approved", displayStatus: "approved" }],
      filter: "approved",
      page: 2,
      pageSize: 20,
      total: 45,
      totalPages: 3,
    });
    const markup = await render({ status: "approved", page: "2" });
    expect(m.listPublishRequestsPage).toHaveBeenCalledWith({ workspaceId: WS, filter: "approved", page: 2, pageSize: 20 });
    expect(markup).toContain('data-testid="approvals-page-info">Trang 2 / 3 · 45 yêu cầu');
    expect(markup).toContain(`href="/w/${WS}/approvals?status=approved"`); // previous = page 1
    expect(markup).toContain(`href="/w/${WS}/approvals?status=approved&amp;page=3"`);
  });

  it.each([
    [{ status: "bogus", page: "abc" }, { filter: "pending", page: 1 }],
    [{ page: "0" }, { filter: "pending", page: 1 }],
    [{ page: "-3" }, { filter: "pending", page: 1 }],
  ])("ignores invalid query values %j", async (searchParams, expected) => {
    await render(searchParams);
    expect(m.listPublishRequestsPage).toHaveBeenCalledWith({ workspaceId: WS, pageSize: 20, ...expected });
  });

  it("a page past the end offers a link back to the first page", async () => {
    m.listPublishRequestsPage.mockResolvedValue({ items: [], filter: "pending", page: 9, pageSize: 20, total: 5, totalPages: 1 });
    expect(await render({ page: "9" })).toContain('data-testid="approvals-first-page"');
  });

  it("members get a notice about who can decide", async () => {
    asRole("member");
    expect(await render({})).toContain('data-testid="approvals-member-notice"');
  });
});

describe("post page", () => {
  it("a draft without a request offers the request form", async () => {
    asRole("member");
    const markup = await postPage();
    expect(markup).toContain('data-testid="request-publish-form"');
    expect(markup).toContain('data-testid="save-post"');
  });

  it("a pending request is shown with a warning that saving cancels it", async () => {
    m.listPublishRequests.mockResolvedValue([request]);
    const markup = await postPage();
    expect(markup).toContain('data-testid="publish-card-pending"');
    expect(markup).toContain('data-testid="post-pending-notice"');
    expect(markup).not.toContain("request-publish-form");
    expect(markup).toContain(`/w/${WS}/approvals/${REQUEST}`);
  });

  it("a published post is read-only: no save, status switch, archive or new request", async () => {
    m.getPost.mockResolvedValue({ ...post, status: "published", version: 4 });
    m.listPublishRequests.mockResolvedValue([{ ...request, status: "approved", displayStatus: "approved", decidedAt: "2026-11-20T12:00:00Z" }]);
    const markup = await postPage();
    expect(markup).toContain('data-testid="post-published-notice"');
    expect(markup).toContain("Đã xuất bản");
    for (const control of ["save-post", "status-switch", "archive-post", "request-publish-form", "cancel-request-form"]) {
      expect(markup).not.toContain(`data-testid="${control}"`);
    }
    expect(markup).toMatch(/<input[^>]*id="post-title"[^>]*disabled/);
  });

  it("the last rejected request is summarised and a new request can be sent", async () => {
    m.listPublishRequests.mockResolvedValue([{ ...request, status: "rejected", displayStatus: "rejected", decisionNote: "Sửa tiêu đề", decidedAt: "2026-11-20T12:00:00Z" }]);
    const markup = await postPage();
    expect(markup).toContain('data-testid="publish-card-last"');
    expect(markup).toContain("Sửa tiêu đề");
    expect(markup).toContain('data-testid="request-publish-form"');
  });
});

describe("workspace navigation", () => {
  it("links to the approvals page with the pending count", async () => {
    m.countPublishRequests.mockResolvedValue({ pending: 1, expired: 1, approved: 250, rejected: 0, cancelled: 0, all: 252 });
    const markup = renderToStaticMarkup(
      await WorkspacePage({ params: Promise.resolve({ workspaceId: WS }), searchParams: Promise.resolve({}) } as never),
    );
    expect(markup).toContain(`href="/w/${WS}/approvals"`);
    expect(markup).toContain('data-testid="approvals-pending-count">1<');
  });
});
