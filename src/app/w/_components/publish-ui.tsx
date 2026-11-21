import type { ReactNode } from "react";

import { ROLE_LABELS } from "@/lib/workspaces/labels";
import type { ContentChangeSource, PublishRequestCancelReason, PublishRequestEvent, WorkspaceRole } from "@/types/database";

import { LocalDateTime } from "./client-ui";
import { Badge } from "./ui";

/**
 * Presentational pieces of the M4 publish-approval UI (no data access, no actions).
 * Usable from server pages and client components.
 */

export type PublishDisplayStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired";

export const PUBLISH_STATUS_LABELS: Record<PublishDisplayStatus, string> = {
  pending: "Chờ duyệt",
  approved: "Đã phê duyệt",
  rejected: "Đã từ chối",
  cancelled: "Đã hủy",
  expired: "Hết hạn",
};

const publishStatusStyle: Record<PublishDisplayStatus, string> = {
  pending: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
  approved: "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-900",
  rejected: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900",
  cancelled: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  expired: "bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700",
};

export function PublishStatusBadge({ status }: { status: PublishDisplayStatus }) {
  return (
    <span
      data-testid="publish-status-badge"
      data-status={status}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${publishStatusStyle[status]}`}
    >
      {PUBLISH_STATUS_LABELS[status]}
    </span>
  );
}

export const CANCEL_REASON_LABELS: Record<PublishRequestCancelReason, string> = {
  withdrawn: "người gửi hoặc quản trị viên đã rút yêu cầu",
  post_changed: "bài viết đã thay đổi sau khi gửi yêu cầu, nên yêu cầu cũ mất hiệu lực",
  expired: "yêu cầu đã quá hạn 7 ngày",
};

const EVENT_LABELS: Record<PublishRequestEvent, string> = {
  requested: "Gửi yêu cầu xuất bản",
  approved: "Phê duyệt",
  rejected: "Từ chối",
  cancelled: "Hủy yêu cầu",
  published: "Xuất bản bài viết",
};

/** What the UI knows about the people in a workspace: role and (optional) display name. */
export type PeopleDirectory = {
  roles: ReadonlyMap<string, WorkspaceRole>;
  names: ReadonlyMap<string, string>;
};

/**
 * Who did it, for approval history: the display name with the role, or only the
 * role when no name is set. Never a user id or an email.
 */
export function actorLabel(userId: string | null, me: string, people: PeopleDirectory): string {
  if (userId === null) return "Người dùng đã xóa";
  const name = people.names.get(userId);
  if (userId === me) return name ? `${name} (bạn)` : "Bạn";
  const role = people.roles.get(userId);
  if (role) return name ? `${name} (${ROLE_LABELS[role]})` : ROLE_LABELS[role];
  return name ? `${name} (cựu thành viên)` : "Cựu thành viên";
}

export type AuditEventView = {
  id: string;
  event: PublishRequestEvent;
  postVersion: number;
  cancelReason: PublishRequestCancelReason | null;
  actor: string;
  actorSource: ContentChangeSource | null;
  createdAt: string;
};

/** Audit trail of one request, oldest first. */
export function AuditTimeline({ events }: { events: AuditEventView[] }) {
  if (events.length === 0) return <p className="text-sm text-slate-500">Chưa có sự kiện nào.</p>;
  return (
    <ol className="space-y-3" data-testid="audit-trail">
      {events.map((e) => (
        <li key={e.id} className="border-l-2 border-slate-200 pl-3 dark:border-slate-700" data-testid="audit-event" data-event={e.event}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{EVENT_LABELS[e.event]}</span>
            {e.actorSource === "agent" ? <Badge tone="indigo">AI đề xuất</Badge> : null}
          </div>
          <p className="text-xs text-slate-500">
            <LocalDateTime iso={e.createdAt} /> · {e.actor} · phiên bản {e.postVersion}
          </p>
          {e.cancelReason ? (
            <p className="text-xs text-slate-600 dark:text-slate-400">Lý do: {CANCEL_REASON_LABELS[e.cancelReason]}.</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Label/value rows of the request summary. */
export function Facts({ items }: { items: { label: string; value: ReactNode; testId?: string }[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-slate-500">{item.label}</dt>
          <dd className="min-w-0 break-words font-medium text-slate-800 dark:text-slate-200" data-testid={item.testId}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
