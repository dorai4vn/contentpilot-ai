import { ArrowRight, Bot, ClipboardCheck, Clock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { contentPaths } from "@/lib/content/paths";
import { publishPermissions } from "@/lib/content/permissions";
import { listPostSummariesByIds } from "@/lib/content/posts";
import {
  countPublishRequests,
  listPublishRequestsPage,
} from "@/lib/content/publish-requests";
import {
  PUBLISH_QUEUE_FILTERS,
  type PublishQueueFilter,
} from "@/lib/validation/publish";
import { listDisplayNames } from "@/lib/profiles/profiles";
import { listPublishingDestinations } from "@/lib/publishing/destinations";
import { listWorkspaceMembers } from "@/lib/workspaces/queries";

import { BulkApprovalList } from "../../_components/bulk-approval";
import { LocalDateTime } from "../../_components/client-ui";
import {
  PUBLISH_STATUS_LABELS,
  PublishStatusBadge,
  actorLabel,
  destinationLabel,
} from "../../_components/publish-ui";
import {
  Badge,
  Breadcrumbs,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  buttonClass,
  segmentClass,
} from "../../_components/ui";
import { loadWorkspace } from "../../_lib/load";

export const metadata: Metadata = { title: "Phê duyệt xuất bản" };

const FILTERS = PUBLISH_QUEUE_FILTERS;
type Filter = PublishQueueFilter;
const PAGE_SIZE = 20;

/** Positive integer from the query string, else 1. */
function pageNumber(value: string | string[] | undefined): number {
  const n =
    typeof value === "string" && /^[1-9]\d{0,5}$/.test(value)
      ? Number(value)
      : 1;
  return n;
}

/**
 * Publish approval queue of a workspace. Read-only: decisions are taken on the
 * review page of each request, after reading the requested version.
 */
export default async function ApprovalsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspaceId]/approvals">) {
  const { workspaceId } = await params;
  const { status, page: pageParam } = await searchParams;
  const filter: Filter = FILTERS.includes(status as Filter)
    ? (status as Filter)
    : "pending";
  const page = pageNumber(pageParam);
  const { user, workspace } = await loadWorkspace(
    workspaceId,
    `/w/${workspaceId}/approvals`,
  );
  const can = publishPermissions(workspace.role);

  // Server-side pagination: only one page of rows is read; counts are exact.
  const [result, counts, members, destinations] = await Promise.all([
    listPublishRequestsPage({
      workspaceId: workspace.id,
      filter,
      page,
      pageSize: PAGE_SIZE,
    }),
    countPublishRequests({ workspaceId: workspace.id }),
    listWorkspaceMembers(workspace.id),
    listPublishingDestinations({
      workspaceId: workspace.id,
      includeDisabled: true,
    }),
  ]);
  const destinationNames = new Map(destinations.map((d) => [d.id, d.name]));
  const shown = result.items;
  const posts = await listPostSummariesByIds({
    workspaceId: workspace.id,
    postIds: shown.map((r) => r.postId),
  });
  const people = {
    roles: new Map(members.map((m) => [m.userId, m.role])),
    names: await listDisplayNames(
      members
        .map((m) => m.userId)
        .concat(shown.flatMap((r) => (r.requestedBy ? [r.requestedBy] : []))),
    ),
  };

  const href = (f: Filter, p = 1) => {
    const params = new URLSearchParams();
    if (f !== "pending") params.set("status", f);
    if (p > 1) params.set("page", String(p));
    const query = params.toString();
    return query
      ? `${contentPaths.approvals(workspace.id)}?${query}`
      : contentPaths.approvals(workspace.id);
  };

  const tab = segmentClass;

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          items={[
            { label: "Bảng điều khiển", href: "/dashboard" },
            {
              label: workspace.name,
              href: contentPaths.workspace(workspace.id),
            },
            { label: "Phê duyệt xuất bản" },
          ]}
        />
        <PageHeader
          icon={ClipboardCheck}
          title="Phê duyệt xuất bản"
          titleTestId="approvals-title"
          description="Mọi bài viết chỉ được xuất bản sau khi chủ sở hữu hoặc quản trị viên đọc và phê duyệt đúng phiên bản được gửi. Yêu cầu hết hạn sau 7 ngày."
        />
      </div>

      {can.decidePublish ? null : (
        <Notice tone="info" testId="approvals-member-notice">
          Bạn là thành viên: bạn có thể gửi và hủy yêu cầu của mình. Chỉ chủ sở
          hữu và quản trị viên mới được phê duyệt hoặc từ chối.
        </Notice>
      )}

      <Card>
        <nav
          className="mb-4 flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1"
          aria-label="Lọc yêu cầu"
        >
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

        {/* Always mounted (keyed by scope) so the bulk result report survives the
            refresh that empties the queue; a new workspace/filter/page remounts
            it and resets selection and confirmation. */}
        <BulkApprovalList
          key={`${workspace.id}:${filter}:${page}`}
          workspaceId={workspace.id}
          emptyState={
            page > 1 && result.total > 0 ? (
              <EmptyState title="Trang này không có yêu cầu nào">
                <Link
                  href={href(filter)}
                  className="text-indigo-600 hover:underline"
                  data-testid="approvals-first-page"
                >
                  Về trang đầu
                </Link>
              </EmptyState>
            ) : (
              <EmptyState
                title={
                  filter === "pending"
                    ? "Không có yêu cầu nào đang chờ duyệt"
                    : "Không có yêu cầu nào"
                }
              >
                Yêu cầu xuất bản được gửi từ trang chi tiết bài viết.
              </EmptyState>
            )
          }
          items={shown.map((r) => {
            const post = posts.get(r.postId);
            const isPending = r.displayStatus === "pending";
            return {
              requestId: r.id,
              title: post?.title ?? "Bài viết không còn truy cập được",
              postVersion: r.postVersion,
              destinationId: r.destinationId,
              destinationName: destinationLabel(
                r.destinationId,
                destinationNames,
              ),
              eligible: isPending && can.decidePublish,
              status: r.displayStatus,
              className: `rounded-xl border p-3.5 transition sm:p-4 ${
                isPending
                  ? "border-amber-200 bg-amber-50/50 shadow-card ring-1 ring-inset ring-amber-100"
                  : "border-slate-200 bg-white hover:border-slate-300"
              }`,
              children: (
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
                      {r.requestSource === "agent" ? (
                        <Badge tone="indigo">
                          <Bot className="h-3 w-3" aria-hidden />
                          AI đề xuất
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-slate-500">
                      <span data-testid="approval-item-destination">
                        Đích xuất bản:{" "}
                        {destinationLabel(r.destinationId, destinationNames)}
                      </span>{" "}
                      · Phiên bản {r.postVersion} · gửi bởi{" "}
                      {actorLabel(r.requestedBy, user.id, people)} ·{" "}
                      <LocalDateTime iso={r.requestedAt} />
                      {r.displayStatus === "pending" ? (
                        <>
                          {" "}
                          · hạn duyệt <LocalDateTime iso={r.expiresAt} />
                        </>
                      ) : null}
                    </p>
                    {r.cancelReason === "post_changed" ? (
                      <p
                        className="text-xs text-amber-700"
                        data-testid="approval-item-stale"
                      >
                        Bài viết đã thay đổi sau khi gửi, yêu cầu này đã mất
                        hiệu lực.
                      </p>
                    ) : null}
                  </div>
                  <Link
                    href={`${contentPaths.approvals(workspace.id)}/${r.id}`}
                    className={`shrink-0 ${isPending && can.decidePublish ? buttonClass.primary : buttonClass.secondary}`}
                  >
                    {isPending ? (
                      <Clock className="h-4 w-4" aria-hidden />
                    ) : null}
                    {isPending && can.decidePublish
                      ? "Xem và duyệt"
                      : "Xem chi tiết"}
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </Link>
                </div>
              ),
            };
          })}
        />

        {result.totalPages > 1 ? (
          <nav
            className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 text-sm"
            aria-label="Phân trang"
            data-testid="approvals-pagination"
          >
            {page > 1 ? (
              <Link
                href={href(filter, Math.min(page - 1, result.totalPages))}
                className="font-medium text-indigo-600 hover:underline"
                data-testid="approvals-prev"
              >
                ← Trang trước
              </Link>
            ) : (
              <span className="text-slate-400">← Trang trước</span>
            )}
            <span
              className="text-slate-600 dark:text-slate-400"
              data-testid="approvals-page-info"
            >
              Trang {page} / {result.totalPages} · {result.total} yêu cầu
            </span>
            {page < result.totalPages ? (
              <Link
                href={href(filter, page + 1)}
                className="font-medium text-indigo-600 hover:underline"
                data-testid="approvals-next"
              >
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
