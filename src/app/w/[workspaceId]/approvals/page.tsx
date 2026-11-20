import type { Metadata } from "next";
import Link from "next/link";

import { contentPaths } from "@/lib/content/paths";
import { publishPermissions } from "@/lib/content/permissions";
import { listPostSummariesByIds } from "@/lib/content/posts";
import { listPublishRequests } from "@/lib/content/publish-requests";
import { listWorkspaceMembers } from "@/lib/workspaces/queries";

import { LocalDateTime } from "../../_components/client-ui";
import { PUBLISH_STATUS_LABELS, type PublishDisplayStatus, PublishStatusBadge, actorLabel } from "../../_components/publish-ui";
import { Badge, Breadcrumbs, Card, EmptyState, Notice } from "../../_components/ui";
import { loadWorkspace } from "../../_lib/load";

export const metadata: Metadata = { title: "Phê duyệt xuất bản" };

const FILTERS = ["pending", "expired", "approved", "rejected", "cancelled", "all"] as const;
type Filter = (typeof FILTERS)[number];

/**
 * Publish approval queue of a workspace. Read-only: decisions are taken on the
 * review page of each request, after reading the requested version.
 */
export default async function ApprovalsPage({ params, searchParams }: PageProps<"/w/[workspaceId]/approvals">) {
  const { workspaceId } = await params;
  const { status } = await searchParams;
  const filter: Filter = FILTERS.includes(status as Filter) ? (status as Filter) : "pending";
  const { user, workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/approvals`);
  const can = publishPermissions(workspace.role);

  const [requests, members] = await Promise.all([
    listPublishRequests({ workspaceId: workspace.id, limit: 100 }),
    listWorkspaceMembers(workspace.id),
  ]);
  const posts = await listPostSummariesByIds({ workspaceId: workspace.id, postIds: requests.map((r) => r.postId) });
  const roles = new Map(members.map((m) => [m.userId, m.role]));

  const counts = Object.fromEntries(FILTERS.map((f) => [f, 0])) as Record<Filter, number>;
  for (const r of requests) {
    counts[r.displayStatus as PublishDisplayStatus] += 1;
    counts.all += 1;
  }
  const shown = filter === "all" ? requests : requests.filter((r) => r.displayStatus === filter);

  const tab = (active: boolean) =>
    `whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${
      active
        ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white"
        : "text-slate-600 hover:text-slate-900 dark:text-slate-400"
    }`;

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          items={[
            { label: "Bảng điều khiển", href: "/dashboard" },
            { label: workspace.name, href: contentPaths.workspace(workspace.id) },
            { label: "Phê duyệt xuất bản" },
          ]}
        />
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="approvals-title">
          Phê duyệt xuất bản
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Mọi bài viết chỉ được xuất bản sau khi chủ sở hữu hoặc quản trị viên đọc và phê duyệt đúng phiên bản được gửi.
          Yêu cầu hết hạn sau 7 ngày.
        </p>
      </div>

      {can.decidePublish ? null : (
        <Notice tone="info" testId="approvals-member-notice">
          Bạn là thành viên: bạn có thể gửi và hủy yêu cầu của mình. Chỉ chủ sở hữu và quản trị viên mới được phê duyệt
          hoặc từ chối.
        </Notice>
      )}

      <Card>
        <nav className="mb-4 flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 dark:bg-slate-900" aria-label="Lọc yêu cầu">
          {FILTERS.map((f) => (
            <Link
              key={f}
              href={f === "pending" ? contentPaths.approvals(workspace.id) : `${contentPaths.approvals(workspace.id)}?status=${f}`}
              className={tab(filter === f)}
              aria-current={filter === f ? "page" : undefined}
              data-testid={`approvals-tab-${f}`}
            >
              {f === "all" ? "Tất cả" : PUBLISH_STATUS_LABELS[f]} ({counts[f]})
            </Link>
          ))}
        </nav>

        {shown.length === 0 ? (
          <EmptyState title={filter === "pending" ? "Không có yêu cầu nào đang chờ duyệt" : "Không có yêu cầu nào"}>
            Yêu cầu xuất bản được gửi từ trang chi tiết bài viết.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800" data-testid="approval-list">
            {shown.map((r) => {
              const post = posts.get(r.postId);
              return (
                <li key={r.id} className="py-3" data-testid="approval-item" data-request-id={r.id} data-status={r.displayStatus}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`${contentPaths.approvals(workspace.id)}/${r.id}`}
                          className="min-w-0 truncate font-medium hover:text-indigo-600 hover:underline"
                          data-testid="approval-item-link"
                        >
                          {post?.title ?? "Bài viết không còn truy cập được"}
                        </Link>
                        <PublishStatusBadge status={r.displayStatus} />
                        {r.requestSource === "agent" ? <Badge tone="indigo">AI đề xuất</Badge> : null}
                      </div>
                      <p className="text-xs text-slate-500">
                        Phiên bản {r.postVersion} · gửi bởi {actorLabel(r.requestedBy, user.id, roles)} ·{" "}
                        <LocalDateTime iso={r.requestedAt} />
                        {r.displayStatus === "pending" ? (
                          <>
                            {" "}
                            · hạn duyệt <LocalDateTime iso={r.expiresAt} />
                          </>
                        ) : null}
                      </p>
                      {r.cancelReason === "post_changed" ? (
                        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="approval-item-stale">
                          Bài viết đã thay đổi sau khi gửi, yêu cầu này đã mất hiệu lực.
                        </p>
                      ) : null}
                    </div>
                    <Link
                      href={`${contentPaths.approvals(workspace.id)}/${r.id}`}
                      className="shrink-0 text-sm font-medium text-indigo-600 hover:underline"
                    >
                      {r.displayStatus === "pending" && can.decidePublish ? "Xem và duyệt →" : "Xem chi tiết →"}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
