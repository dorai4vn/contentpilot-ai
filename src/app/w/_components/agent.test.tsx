import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import type { AgentApiAction } from "@/lib/agent/client";

import { ActionList, apiActionToView, logEntryToView } from "./agent-actions";
import { AGENT_SUGGESTIONS, AgentChat, type ChatEntry, ChatBubble, historyForApi } from "./agent-chat";

const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";
const USER = "11111111-1111-4111-8111-111111111111";

const actions: AgentApiAction[] = [
  { tool: "get_post", label: "x", kind: "read", status: "success", effect: { kind: "read", postId: POST, versionAfter: 3 }, log: "recorded" },
  {
    tool: "update_post",
    label: "x",
    kind: "update",
    status: "success",
    effect: { kind: "update", postId: POST, projectId: PROJECT, versionBefore: 3, versionAfter: 4, fields: ["body", "title"] },
    log: "recorded",
  },
  {
    tool: "create_post",
    label: "x",
    kind: "create",
    status: "error",
    code: "forbidden",
    message: "Bạn không có quyền thực hiện thao tác này.",
    effect: { kind: "create", projectId: PROJECT },
    log: "failed",
  },
  { tool: "delete_post", label: "x", kind: "unknown", status: "error", code: "unknown_tool", log: "recorded" },
  { tool: "update_post", label: "x", kind: "update", status: "skipped", code: "write_limit", log: "recorded" },
];

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("ActionList (from server actions)", () => {
  const markup = html(<ActionList items={actions.map((a, i) => apiActionToView(WS, a, i))} />);

  it("uses Vietnamese tool names from our own labels, not the server's label text", () => {
    for (const label of ["Đọc nội dung bài viết", "Cập nhật bài viết", "Tạo bài viết", "Công cụ không hợp lệ"]) {
      expect(markup).toContain(label);
    }
  });

  it("shows success / failure / skipped", () => {
    expect(markup.match(/data-status="success"/g)).toHaveLength(2);
    expect(markup.match(/data-status="error"/g)).toHaveLength(2);
    expect(markup).toContain('data-status="skipped"');
    expect(markup).toContain("Thành công");
    expect(markup).toContain("Thất bại");
    expect(markup).toContain("Bỏ qua");
  });

  it("links to the post and shows versions before → after and changed fields", () => {
    expect(markup).toContain(`href="/w/${WS}/posts/${POST}"`);
    expect(markup).toContain("Phiên bản 3 → 4");
    expect(markup).toContain("Đã đổi: nội dung, tiêu đề");
    expect(markup).toContain("Đã đọc phiên bản 3");
  });

  it("explains failures from the code and flags actions that could not be logged", () => {
    expect(markup).toContain("Không có quyền thực hiện.");
    expect(markup).toContain("Công cụ không được phép.");
    expect(markup).toContain("Đã đạt giới hạn số thao tác ghi.");
    expect(markup).toContain("Chưa ghi được nhật ký");
  });

  it("never shows a version for a failed action", () => {
    const failed = html(
      <ActionList
        items={[
          apiActionToView(WS, {
            ...actions[1]!,
            status: "error",
            code: "version_conflict",
          }, 0),
        ]}
      />,
    );
    expect(failed).not.toContain("Phiên bản 3 → 4");
    expect(failed).toContain("Bài viết vừa được người khác thay đổi; không ghi đè.");
  });
});

describe("Recent AI activity (from agent_actions)", () => {
  const entry = {
    id: "a1",
    userId: USER,
    tool: "update_post",
    kind: "update" as const,
    status: "success" as const,
    errorCode: null,
    projectId: PROJECT,
    postId: POST,
    versionBefore: 3,
    versionAfter: 4,
    fields: ["body"],
    createdAt: "2026-11-20T10:00:00Z",
  };

  it("shows the action, a link, versions, time and who did it", () => {
    const markup = html(<ActionList items={[logEntryToView(WS, entry, USER)]} />);
    expect(markup).toContain("Cập nhật bài viết");
    expect(markup).toContain(`href="/w/${WS}/posts/${POST}"`);
    expect(markup).toContain("Phiên bản 3 → 4");
    expect(markup).toContain("bạn");
    expect(markup).toContain('dateTime="2026-11-20T10:00:00Z"');
  });

  it("names other members neutrally", () => {
    expect(logEntryToView(WS, { ...entry, userId: "other" }, USER).actor).toBe("thành viên khác");
    expect(logEntryToView(WS, { ...entry, userId: null }, USER).actor).toBe("tài khoản đã xóa");
  });
});

describe("AgentChat (initial render)", () => {
  const markup = html(
    <AgentChat workspaceId={WS} projects={[{ id: PROJECT, name: "Blog" }]} initialProjectId={PROJECT} />,
  );

  it("shows the empty state with quick suggestions", () => {
    expect(markup).toContain("Bạn muốn Trợ lý AI giúp gì?");
    for (const suggestion of AGENT_SUGGESTIONS) expect(markup).toContain(suggestion);
  });

  it("offers an optional project choice, preselected from the URL", () => {
    expect(markup).toContain(">Tất cả dự án<");
    expect(markup).toMatch(new RegExp(`<option value="${PROJECT}" selected="">Blog</option>`));
  });

  it("has a labelled input with the length limit and a disabled send button while empty", () => {
    expect(markup).toContain('maxLength="4000"');
    expect(markup).toContain("Yêu cầu cho Trợ lý AI");
    expect(markup).toMatch(/<button type="submit" disabled=""[^>]*data-testid="agent-send"/);
  });

  it("contains no publish or delete control", () => {
    expect(markup.toLowerCase()).not.toMatch(/xuất bản|xóa bài|publish|delete/);
  });
});

describe("ChatBubble", () => {
  const assistant = (overrides: Partial<Extract<ChatEntry, { role: "assistant" }>> = {}) =>
    html(
      <ChatBubble
        workspaceId={WS}
        entry={{
          id: "1",
          role: "assistant",
          content: "Mình đã cập nhật bài viết.",
          actions,
          stopReason: "completed",
          partial: false,
          ...overrides,
        }}
      />,
    );

  it("lists 'Thao tác đã thực hiện' from the server actions", () => {
    const markup = assistant();
    expect(markup).toContain("Thao tác đã thực hiện");
    expect(markup.match(/data-testid="action-item"/g)).toHaveLength(actions.length);
  });

  it("warns clearly when part of the work was done before the assistant stopped", () => {
    const markup = assistant({ stopReason: "model_error", partial: true });
    expect(markup).toContain("Một phần thao tác đã được thực hiện trước khi Trợ lý dừng");
  });

  it("explains a limit stop without writes", () => {
    const markup = assistant({ stopReason: "tool_limit", partial: false, actions: [actions[0]!] });
    expect(markup).toContain("giới hạn 6 lần gọi công cụ");
  });

  it("does not invent actions the server did not report", () => {
    const markup = assistant({ content: "Mình đã xuất bản và xóa 3 bài!", actions: [] });
    expect(markup).not.toContain("Thao tác đã thực hiện");
    expect(markup).not.toContain('data-testid="action-item"');
  });

  it.each([
    ["rate_limited", "Bạn gửi yêu cầu quá nhanh.", 'role="alert"'],
    ["timeout", "Trợ lý AI phản hồi quá lâu.", 'role="alert"'],
    ["service", "Dịch vụ AI tạm thời không phản hồi.", 'role="alert"'],
  ] as const)("renders %s errors", (kind, message, role) => {
    const markup = html(<ChatBubble workspaceId={WS} entry={{ id: "e", role: "error", content: message, kind }} />);
    expect(markup).toContain(message);
    expect(markup).toContain(role);
    expect(markup).toContain(`data-kind="${kind}"`);
  });

  it("offers to sign in again when the session expired", () => {
    const markup = html(
      <ChatBubble workspaceId={WS} entry={{ id: "e", role: "error", content: "Hết phiên.", kind: "unauthenticated" }} />,
    );
    expect(markup).toContain('href="/login"');
  });

  it("escapes user and assistant text (no HTML injection)", () => {
    const markup = html(
      <ChatBubble workspaceId={WS} entry={{ id: "u", role: "user", content: '<img src=x onerror="alert(1)">' }} />,
    );
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
  });
});

describe("historyForApi", () => {
  it("sends only user/assistant texts, never errors or actions", () => {
    const entries: ChatEntry[] = [
      { id: "1", role: "user", content: "Tạo bài" },
      { id: "2", role: "assistant", content: "Đã tạo.", actions, stopReason: "completed", partial: false },
      { id: "3", role: "error", content: "Lỗi mạng", kind: "network" },
    ];
    expect(historyForApi(entries)).toEqual([
      { role: "user", content: "Tạo bài" },
      { role: "assistant", content: "Đã tạo." },
    ]);
  });
});
