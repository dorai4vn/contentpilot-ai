import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { contentPaths } from "@/lib/content/paths";
import { publishPermissions } from "@/lib/content/permissions";
import { getPost, getPostHistory } from "@/lib/content/posts";
import { getProject } from "@/lib/content/projects";
import { listPublishRequests } from "@/lib/content/publish-requests";
import { getInternalDestination } from "@/lib/publishing/destinations";

import { LocalDateTime } from "../../../_components/client-ui";
import { ArchivePostButton, type EditablePost, PostEditor, StatusSwitch } from "../../../_components/post-forms";
import { CancelRequestForm, RequestPublishForm } from "../../../_components/publish-forms";
import { CANCEL_REASON_LABELS, PublishStatusBadge } from "../../../_components/publish-ui";
import { Badge, Breadcrumbs, Card, Notice, STATUS_LABELS, StatusBadge } from "../../../_components/ui";
import { loadWorkspace, routeId } from "../../../_lib/load";

export const metadata: Metadata = { title: "Soạn thảo bài viết" };

export default async function PostEditorPage({ params }: PageProps<"/w/[workspaceId]/posts/[postId]">) {
  const { workspaceId, postId: postParam } = await params;
  const { user, workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/posts/${postParam}`);

  const postId = routeId(postParam);
  const [post, history] = await Promise.all([getPost({ postId }), getPostHistory({ postId })]);
  if (!post || post.workspaceId !== workspace.id) notFound();
  const [project, requests, internalDestination] = await Promise.all([
    getProject({ projectId: post.projectId }),
    listPublishRequests({ workspaceId: workspace.id, postId: post.id, limit: 10 }),
    // Requests always name their destination; today only the internal one exists.
    getInternalDestination({ workspaceId: workspace.id }),
  ]);
  if (!project) notFound();

  const projectArchived = project.archivedAt !== null;
  const postArchived = post.archivedAt !== null;
  const published = post.status === "published";
  // A published post is read-only (the database rejects any change: CP422).
  const readOnly = postArchived || projectArchived || published;

  const can = publishPermissions(workspace.role);
  const latest = requests[0] ?? null;
  const open = requests.find((r) => r.status === "pending") ?? null;
  const openValid = open !== null && open.displayStatus === "pending" && open.postVersion === post.version;
  const approval = published ? (requests.find((r) => r.status === "approved") ?? null) : null;
  const reviewPath = (id: string) => `${contentPaths.approvals(workspace.id)}/${id}`;

  const editable: EditablePost = {
    id: post.id,
    workspaceId: post.workspaceId,
    projectId: post.projectId,
    title: post.title,
    body: post.body,
    status: post.status,
    scheduledFor: post.scheduledFor,
    version: post.version,
    archivedAt: post.archivedAt,
  };

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          items={[
            { label: "Bảng điều khiển", href: "/dashboard" },
            { label: workspace.name, href: contentPaths.workspace(workspace.id) },
            { label: project.name, href: contentPaths.project(workspace.id, project.id) },
            { label: post.title },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight" data-testid="post-heading">
            {post.title}
          </h1>
          <StatusBadge status={post.status} />
          {postArchived ? <Badge tone="amber">Đã lưu trữ</Badge> : null}
          <span className="text-sm text-slate-500" data-testid="post-version">
            Phiên bản {post.version}
          </span>
        </div>
      </div>

      {published ? (
        <Notice tone="success" testId="post-published-notice">
          Bài viết đã được xuất bản
          {approval?.decidedAt ? (
            <>
              {" "}
              lúc <LocalDateTime iso={approval.decidedAt} />
            </>
          ) : null}{" "}
          và chỉ có thể xem. Không thể sửa, lưu trữ hay gửi yêu cầu xuất bản lại.
        </Notice>
      ) : openValid ? (
        <Notice tone="info" testId="post-pending-notice">
          Phiên bản {open.postVersion} đang chờ duyệt xuất bản. Nếu bạn lưu thay đổi, yêu cầu này sẽ tự động bị hủy và cần
          gửi lại.
        </Notice>
      ) : null}

      {postArchived ? (
        <Notice tone="warning" testId="post-archived-notice">
          Bài viết này đã được lưu trữ và chỉ có thể xem. Hãy khôi phục để chỉnh sửa.
        </Notice>
      ) : projectArchived ? (
        <Notice tone="warning" testId="post-archived-notice">
          Dự án đã được lưu trữ nên bài viết này chỉ có thể xem.
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <PostEditor post={editable} readOnly={readOnly} />
        </Card>

        <aside className="space-y-6">
          <Card>
            <h2 className="mb-1 font-semibold">Trạng thái</h2>
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
              {published
                ? "Đã xuất bản: bài viết chỉ có thể xem."
                : post.status === "ready"
                  ? "Sẵn sàng: bài viết đã soạn xong và có thể gửi yêu cầu xuất bản."
                  : "Bản nháp: bài viết vẫn đang được soạn."}
            </p>
            {readOnly ? null : <StatusSwitch key={`status-${post.version}`} post={editable} />}
          </Card>

          <Card data-testid="publish-card">
            <h2 className="mb-1 font-semibold">Xuất bản</h2>
            {published ? (
              <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="publish-card-published">
                Bài viết đã được xuất bản sau khi được phê duyệt.
                {approval ? (
                  <>
                    {" "}
                    <Link href={reviewPath(approval.id)} className="text-indigo-600 hover:underline">
                      Xem yêu cầu đã duyệt
                    </Link>
                  </>
                ) : null}
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Bài viết chỉ được xuất bản sau khi chủ sở hữu hoặc quản trị viên phê duyệt đúng phiên bản bạn gửi.
                </p>
                {openValid ? (
                  <div className="space-y-2" data-testid="publish-card-pending">
                    <div className="flex items-center gap-2 text-sm">
                      <PublishStatusBadge status="pending" /> Phiên bản {open.postVersion}
                    </div>
                    <Link href={reviewPath(open.id)} className="text-sm font-medium text-indigo-600 hover:underline" data-testid="open-review">
                      {can.decidePublish ? "Xem và duyệt →" : "Xem yêu cầu →"}
                    </Link>
                    {open.requestedBy === user.id || can.cancelAnyRequest ? (
                      <CancelRequestForm workspaceId={workspace.id} requestId={open.id} />
                    ) : null}
                  </div>
                ) : (
                  <>
                    {latest && latest.status !== "approved" ? (
                      <p className="text-xs text-slate-500" data-testid="publish-card-last">
                        Yêu cầu gần nhất (phiên bản {latest.postVersion}): <PublishStatusBadge status={latest.displayStatus} />
                        {latest.cancelReason ? <> — {CANCEL_REASON_LABELS[latest.cancelReason]}</> : null}
                        {latest.status === "rejected" && latest.decisionNote ? <> — lý do: “{latest.decisionNote}”</> : null}{" "}
                        <Link href={reviewPath(latest.id)} className="text-indigo-600 hover:underline">
                          Chi tiết
                        </Link>
                      </p>
                    ) : null}
                    {readOnly ? (
                      <p className="text-xs text-slate-500">Không thể gửi yêu cầu khi bài viết hoặc dự án đang được lưu trữ.</p>
                    ) : (
                      <RequestPublishForm
                        key={`publish-${post.version}`}
                        workspaceId={workspace.id}
                        postId={post.id}
                        version={post.version}
                        destination={{ id: internalDestination.id, name: internalDestination.name }}
                      />
                    )}
                  </>
                )}
              </div>
            )}
          </Card>

          {published ? null : (
            <Card>
              <h2 className="mb-1 font-semibold">Lưu trữ</h2>
              <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
                Bài viết được lưu trữ vẫn giữ nguyên lịch sử và có thể khôi phục. Không có dữ liệu nào bị xóa.
              </p>
              <ArchivePostButton key={`archive-${post.version}`} post={editable} projectArchived={projectArchived} />
            </Card>
          )}

          <Card>
            <h2 className="mb-3 font-semibold">Lịch sử phiên bản</h2>
            {history.length === 0 ? (
              <p className="text-sm text-slate-500">Chưa có lịch sử.</p>
            ) : (
              <ol className="space-y-3" data-testid="version-history">
                {history.map((v, index) => {
                  const previous = history[index + 1];
                  const changes = previous
                    ? [
                        v.title !== previous.title ? "sửa tiêu đề" : null,
                        v.body !== previous.body ? "sửa nội dung" : null,
                        v.status !== previous.status ? `trạng thái → ${STATUS_LABELS[v.status]}` : null,
                        v.scheduledFor !== previous.scheduledFor ? "đổi lịch đăng" : null,
                        (v.archivedAt === null) !== (previous.archivedAt === null)
                          ? v.archivedAt
                            ? "lưu trữ"
                            : "khôi phục"
                          : null,
                      ].filter(Boolean)
                    : ["tạo bài viết"];
                  return (
                    <li key={v.id} className="border-l-2 border-slate-200 pl-3 dark:border-slate-700" data-testid="version-item">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium">Phiên bản {v.version}</span>
                        <StatusBadge status={v.status} />
                        {v.changeSource === "agent" ? <Badge tone="indigo">AI</Badge> : null}
                      </div>
                      <p className="text-xs text-slate-500">
                        <LocalDateTime iso={v.createdAt} /> ·{" "}
                        {v.changedBy === user.id ? "bạn" : v.changedBy ? "thành viên khác" : "tài khoản đã xóa"}
                      </p>
                      <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="version-changes">
                        {changes.length ? changes.join(", ") : "không thay đổi nội dung"}
                      </p>
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Xem phiên bản này</summary>
                        <p className="mt-1 font-medium">{v.title}</p>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono dark:bg-slate-900">
                          {v.body || "(trống)"}
                        </pre>
                      </details>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
