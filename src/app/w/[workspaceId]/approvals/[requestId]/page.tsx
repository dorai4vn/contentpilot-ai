import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { contentPaths } from "@/lib/content/paths";
import { publishPermissions } from "@/lib/content/permissions";
import { getPost, getPostHistory } from "@/lib/content/posts";
import { getPublishRequest } from "@/lib/content/publish-requests";
import { listWorkspaceMembers } from "@/lib/workspaces/queries";

import { LocalDateTime } from "../../../_components/client-ui";
import { ApproveForm, CancelRequestForm, RejectForm } from "../../../_components/publish-forms";
import { AuditTimeline, CANCEL_REASON_LABELS, Facts, PublishStatusBadge, actorLabel } from "../../../_components/publish-ui";
import { Badge, Breadcrumbs, Card, Notice, StatusBadge } from "../../../_components/ui";
import { loadWorkspace, routeId } from "../../../_lib/load";

export const metadata: Metadata = { title: "Duyệt yêu cầu xuất bản" };

/**
 * Review of one publish request: the exact version that was requested (title and
 * body from the version history), who asked and when, the deadline and the audit
 * trail. Rendering never changes anything; approval is an explicit two-step form.
 */
export default async function ApprovalReviewPage({ params }: PageProps<"/w/[workspaceId]/approvals/[requestId]">) {
  const { workspaceId, requestId: requestParam } = await params;
  const { user, workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/approvals/${requestParam}`);
  const can = publishPermissions(workspace.role);

  const requestId = routeId(requestParam);
  const detail = await getPublishRequest({ requestId });
  if (!detail || detail.request.workspaceId !== workspace.id) notFound();
  const { request, events } = detail;

  const [post, history, members] = await Promise.all([
    getPost({ postId: request.postId }),
    getPostHistory({ postId: request.postId }),
    listWorkspaceMembers(workspace.id),
  ]);
  if (!post || post.workspaceId !== workspace.id) notFound();
  const roles = new Map(members.map((m) => [m.userId, m.role]));
  const who = (id: string | null) => actorLabel(id, user.id, roles);

  // The content that was requested: that version's snapshot, never the current post.
  const requested = history.find((v) => v.version === request.postVersion) ?? null;
  const status = request.displayStatus;
  const stillCurrent = post.version === request.postVersion && post.status !== "published" && post.archivedAt === null;
  const decidable = status === "pending" && stillCurrent && can.decidePublish;
  const cancellable =
    request.status === "pending" && (request.requestedBy === user.id || can.cancelAnyRequest);

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          items={[
            { label: "Bảng điều khiển", href: "/dashboard" },
            { label: workspace.name, href: contentPaths.workspace(workspace.id) },
            { label: "Phê duyệt xuất bản", href: contentPaths.approvals(workspace.id) },
            { label: requested?.title ?? post.title },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight" data-testid="review-title">
            Yêu cầu xuất bản
          </h1>
          <PublishStatusBadge status={status} />
          {request.requestSource === "agent" ? <Badge tone="indigo">AI đề xuất</Badge> : null}
        </div>
      </div>

      {status === "expired" ? (
        <Notice tone="warning" testId="review-expired">
          Yêu cầu này đã hết hạn sau 7 ngày nên không thể phê duyệt. Người gửi có thể gửi yêu cầu mới.
        </Notice>
      ) : null}
      {request.cancelReason === "post_changed" || (status === "pending" && !stillCurrent) ? (
        <Notice tone="warning" testId="review-stale">
          Bài viết đã thay đổi sau khi gửi yêu cầu (hiện là phiên bản {post.version}). Yêu cầu này đã mất hiệu lực và
          không thể dùng để xuất bản phiên bản mới. Hãy gửi yêu cầu mới từ trang bài viết.
        </Notice>
      ) : null}
      {status === "approved" ? (
        <Notice tone="success" testId="review-approved">
          Đã được {who(request.decidedBy)} phê duyệt
          {request.decidedAt ? (
            <>
              {" "}
              lúc <LocalDateTime iso={request.decidedAt} />
            </>
          ) : null}
          . Bài viết đã xuất bản.
        </Notice>
      ) : null}
      {status === "rejected" ? (
        <Notice tone="error" testId="review-rejected">
          Đã bị {who(request.decidedBy)} từ chối
          {request.decisionNote ? <>. Lý do: “{request.decisionNote}”</> : null}.
        </Notice>
      ) : null}
      {status === "cancelled" && request.cancelReason && request.cancelReason !== "post_changed" ? (
        <Notice tone="info" testId="review-cancelled">
          Yêu cầu đã bị hủy: {CANCEL_REASON_LABELS[request.cancelReason]}.
        </Notice>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <h2 className="mb-3 font-semibold">Thông tin yêu cầu</h2>
            <Facts
              items={[
                {
                  label: "Bài viết",
                  value: (
                    <Link href={contentPaths.post(workspace.id, post.id)} className="text-indigo-600 hover:underline">
                      {post.title}
                    </Link>
                  ),
                },
                { label: "Phiên bản xin duyệt", value: `Phiên bản ${request.postVersion}`, testId: "review-requested-version" },
                {
                  label: "Phiên bản hiện tại",
                  value: (
                    <span className="inline-flex items-center gap-2">
                      Phiên bản {post.version} <StatusBadge status={post.status} />
                    </span>
                  ),
                  testId: "review-current-version",
                },
                { label: "Người gửi", value: who(request.requestedBy), testId: "review-requester" },
                { label: "Thời điểm gửi", value: <LocalDateTime iso={request.requestedAt} />, testId: "review-requested-at" },
                { label: "Hạn duyệt", value: <LocalDateTime iso={request.expiresAt} />, testId: "review-expires-at" },
                ...(request.reason ? [{ label: "Ghi chú của người gửi", value: `“${request.reason}”` }] : []),
              ]}
            />
          </Card>

          <Card>
            <h2 className="mb-1 font-semibold">Nội dung phiên bản {request.postVersion}</h2>
            <p className="mb-3 text-xs text-slate-500">Đây chính là nội dung sẽ được xuất bản nếu yêu cầu được phê duyệt.</p>
            {requested ? (
              <article className="space-y-2" data-testid="review-content">
                <h3 className="text-lg font-semibold" data-testid="review-content-title">
                  {requested.title}
                </h3>
                <pre
                  className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-50 p-3 font-mono text-sm leading-relaxed dark:bg-slate-900"
                  data-testid="review-content-body"
                >
                  {requested.body || "(trống)"}
                </pre>
              </article>
            ) : (
              <Notice tone="warning" testId="review-content-missing">
                Không tải được nội dung của phiên bản này.
              </Notice>
            )}
          </Card>
        </div>

        <aside className="space-y-6">
          <Card>
            <h2 className="mb-3 font-semibold">Quyết định</h2>
            {decidable && requested ? (
              <div className="space-y-5" data-testid="decision-panel">
                <ApproveForm
                  target={{
                    workspaceId: workspace.id,
                    requestId: request.id,
                    postTitle: requested.title,
                    postVersion: request.postVersion,
                  }}
                />
                <hr className="border-slate-200 dark:border-slate-800" />
                <RejectForm workspaceId={workspace.id} requestId={request.id} />
              </div>
            ) : status === "pending" && stillCurrent && !can.decidePublish ? (
              <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="decision-not-allowed">
                Đang chờ chủ sở hữu hoặc quản trị viên phê duyệt. Bạn không có quyền phê duyệt hay từ chối.
              </p>
            ) : (
              <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="decision-closed">
                Yêu cầu này không còn chờ quyết định.
              </p>
            )}
            {cancellable ? (
              <div className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-800">
                <CancelRequestForm workspaceId={workspace.id} requestId={request.id} />
              </div>
            ) : null}
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold">Lịch sử kiểm toán</h2>
            <AuditTimeline
              events={events.map((e) => ({
                id: e.id,
                event: e.event,
                postVersion: e.postVersion,
                cancelReason: e.cancelReason,
                actor: who(e.actorId),
                actorSource: e.actorSource,
                createdAt: e.createdAt,
              }))}
            />
          </Card>
        </aside>
      </div>
    </div>
  );
}
