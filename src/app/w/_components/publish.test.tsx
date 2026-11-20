import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const actions = vi.hoisted(() => ({
  requestPublishAction: vi.fn(),
  approvePublishAction: vi.fn(),
  rejectPublishAction: vi.fn(),
  cancelPublishAction: vi.fn(),
}));
vi.mock("@/app/_actions/content/publish", () => actions);

import { ApproveForm, CancelRequestForm, RejectForm, RequestPublishForm } from "./publish-forms";
import { AuditTimeline, PUBLISH_STATUS_LABELS, PublishStatusBadge, actorLabel } from "./publish-ui";

const WS = "22222222-2222-4222-8222-222222222222";
const POST = "44444444-4444-4444-8444-444444444444";
const REQUEST = "66666666-6666-4666-8666-666666666666";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "55555555-5555-4555-8555-555555555555";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

/** Name -> value of every form field in the markup. */
function fields(markup: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of markup.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
    const attrs = match[2]!;
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1];
    if (name) result[name] = /\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? "";
  }
  return result;
}

describe("RequestPublishForm", () => {
  const markup = html(<RequestPublishForm workspaceId={WS} postId={POST} version={4} />);

  it("sends only workspace, post, the version shown and an optional reason", () => {
    expect(fields(markup)).toEqual({ workspaceId: WS, postId: POST, expectedVersion: "4", reason: "" });
  });

  it("names the version being requested, in Vietnamese", () => {
    expect(markup).toContain("Gửi yêu cầu xuất bản phiên bản 4");
    expect(markup).toContain('maxLength="500"');
  });

  it("never carries approval fields", () => {
    expect(markup).not.toMatch(/name="(confirm|status|requestedBy|decidedBy|role|userId)"/);
  });
});

describe("ApproveForm: explicit two-step approval", () => {
  const target = { workspaceId: WS, requestId: REQUEST, postTitle: "Ra mắt <b>AI</b>", postVersion: 3 };
  const markup = html(<ApproveForm target={target} />);

  it("first renders only a button that submits nothing", () => {
    expect(markup).toContain('data-testid="approve-start"');
    expect(markup).toMatch(/<button type="button"[^>]*data-testid="approve-start"/);
    expect(markup).not.toContain("<form");
    expect(fields(markup)).toEqual({});
    expect(markup).not.toContain('name="confirm"');
    expect(markup).not.toContain("approve-confirm");
  });

  it("does not call any action while rendering (no implicit approval)", () => {
    expect(actions.approvePublishAction).not.toHaveBeenCalled();
  });
});

describe("RejectForm / CancelRequestForm", () => {
  it("reject sends workspace, request and an optional note only", () => {
    const markup = html(<RejectForm workspaceId={WS} requestId={REQUEST} />);
    expect(fields(markup)).toEqual({ workspaceId: WS, requestId: REQUEST, note: "" });
    expect(markup).toContain("Lý do từ chối");
    expect(markup).not.toContain('name="confirm"');
  });

  it("cancel sends workspace and request only", () => {
    const markup = html(<CancelRequestForm workspaceId={WS} requestId={REQUEST} />);
    expect(fields(markup)).toEqual({ workspaceId: WS, requestId: REQUEST });
    expect(markup).toContain("Hủy yêu cầu");
  });
});

describe("labels", () => {
  it("has a Vietnamese label for every display status", () => {
    expect(PUBLISH_STATUS_LABELS).toEqual({
      pending: "Chờ duyệt",
      approved: "Đã phê duyệt",
      rejected: "Đã từ chối",
      cancelled: "Đã hủy",
      expired: "Hết hạn",
    });
    expect(html(<PublishStatusBadge status="expired" />)).toContain("Hết hạn");
  });

  it("names actors without exposing anything but role and a short id", () => {
    const roles = new Map([[OTHER, "admin" as const]]);
    expect(actorLabel(ME, ME, roles)).toBe("Bạn");
    expect(actorLabel(OTHER, ME, roles)).toBe("Quản trị viên #55555555");
    expect(actorLabel(null, ME, roles)).toBe("Tài khoản đã xóa");
    expect(actorLabel("77777777-7777-4777-8777-777777777777", ME, roles)).toMatch(/^Người không còn trong không gian làm việc/);
  });

  it("audit timeline shows who, what, when and the version, escaping text", () => {
    const markup = html(
      <AuditTimeline
        events={[
          { id: "1", event: "requested", postVersion: 3, cancelReason: null, actor: "Bạn", actorSource: "agent", createdAt: "2026-11-20T10:00:00Z" },
          { id: "2", event: "approved", postVersion: 3, cancelReason: null, actor: "Chủ sở hữu #abc", actorSource: "user", createdAt: "2026-11-20T11:00:00Z" },
          { id: "3", event: "published", postVersion: 4, cancelReason: null, actor: "<script>", actorSource: "user", createdAt: "2026-11-20T11:00:00Z" },
          { id: "4", event: "cancelled", postVersion: 3, cancelReason: "post_changed", actor: "Bạn", actorSource: "user", createdAt: "2026-11-20T12:00:00Z" },
        ]}
      />,
    );
    for (const text of ["Gửi yêu cầu xuất bản", "AI đề xuất", "Phê duyệt", "Xuất bản bài viết", "Chủ sở hữu #abc", "phiên bản 4", "bài viết đã thay đổi"]) {
      expect(markup).toContain(text);
    }
    expect(markup).not.toContain("<script>");
    expect(markup).toContain('dateTime="2026-11-20T10:00:00Z"');
  });
});
