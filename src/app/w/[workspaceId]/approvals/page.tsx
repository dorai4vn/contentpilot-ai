import type { Metadata } from "next";
import Link from "next/link";

import { contentPaths } from "@/lib/content/paths";
import { publishPermissions } from "@/lib/content/permissions";
import { listPostSummariesByIds } from "@/lib/content/posts";
import { countPublishRequests, listPublishRequestsPage } from "@/lib/content/publish-requests";
import { PUBLISH_QUEUE_FILTERS, type PublishQueueFilter } from "@/lib/validation/publish";
import { listWorkspaceMembers } from "@/lib/workspaces/queries";

import { LocalDateTime } from "../../_components/client-ui";
import { PUBLISH_STATUS_LABELS, PublishStatusBadge, actorLabel } from "../../_components/publish-ui";
import { Badge, Breadcrumbs, Card, EmptyState, Notice } from "../../_components/ui";
import { loadWorkspace } from "../../_lib/load";

export const metadata: Metadata = { title: "Phê duyệt xuất bản" };

const FILTERS = PUBLISH_QUEUE_FILTERS;
type Filter = PublishQueueFilter;
const PAGE_SIZE = 20;

/** Positive integer from the query string, else 1. */
function pageNumber(value: string | string[] | undefined): number {
  const n = typeof value === "string" && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : 1;
  return n;
}

/**
 * Publish approval queue of a workspace. Read-only: decisions are taken on the
 * review page of each request, after reading the requested version.
 */
export default async function ApprovalsPage({ params, searchParams }: PageProps<"/w/[workspaceId]/approvals">) {
  const { workspaceId } = await params;
  const { status, page: pageParam } = await searchParams;
  const filter: Filter = FILTERS.includes(status as Filter) ? (status as Filter) : "pending";
  const page = pageNumber(pageParam);
  const { user, workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/approvals`);
  const can = publishPermissions(workspace.role);

  // Server-side pagination: only one page of rows is read; counts are exact.
  const [result, counts, members] = await Promise.all([
    listPublishRequestsPage({ workspaceId: workspace.id, filter, page, pageSize: PAGE_SIZE }),
    countPublishRequests({ workspaceId: workspace.id }),
    listWorkspaceMembers(workspace.id),
  ]);
  const shown = result.items;
  const posts = await listPostSummariesByIds({ workspaceId: workspace.id, postIds: shown.map((r) => r.postId) });
  const roles = new Map(members.map((m) => [m.userId, m.role]));

  const href = (f: Filter, p = 1) => {
    const params = new URLSearchParams();
    if (f !== "pending") params.set("status", f);
    if (p > 1) params.set("page", String(p));
    const query = params.toString();
    return query ? `${contentPaths.approvals(workspace.id)}?${query}` : contentPaths.approvals(workspace.id);
  };

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
              href={href(f)}
              className={tab(filter === f)}
              aria-current={filter === f ? "page" : undefined}
              data-testid={`approvals-tab-${f}`}
            >
              {f === "all" ? "Tất cả" : PUBLISH_STATUS_LABELS[f]} ({counts[f]})
            </Link>
          ))}
        </nav>

        {shown.length === 0 ? (
          page > 1 && result.total > 0 ? (
            <EmptyState title="Trang này không có yêu cầu nào">
              <Link href={href(filter)} className="text-indigo-600 hover:underline" data-testid="approvals-first-page">
                Về trang đầu
              </Link>
            </EmptyState>
          ) : (
            <EmptyState title={filter === "pending" ? "Không có yêu cầu nào đang chờ duyệt" : "Không có yêu cầu nào"}>
              Yêu cầu xuất bản được gửi từ trang chi tiết bài viết.
            </EmptyState>
          )
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

        {result.totalPages > 1 ? (
          <nav
            className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 text-sm dark:border-slate-800"
            aria-label="Phân trang"
            data-testid="approvals-pagination"
          >
            {page > 1 ? (
              <Link href={href(filter, Math.min(page - 1, result.totalPages))} className="font-medium text-indigo-600 hover:underline" data-testid="approvals-prev">
                ← Trang trước
              </Link>
            ) : (
              <span className="text-slate-400">← Trang trước</span>
            )}
            <span className="text-slate-600 dark:text-slate-400" data-testid="approvals-page-info">
              Trang {page} / {result.totalPages} · {result.total} yêu cầu
            </span>
            {page < result.totalPages ? (
              <Link href={href(filter, page + 1)} className="font-medium text-indigo-600 hover:underline" data-testid="approvals-next">
                Trang sau →
              </Link>
            ) : (
              <span className="text-slate-400">Trang sau →</span>
            )}
          </nav>
        ) : null}
      </Card>
    </div>
  );
}
