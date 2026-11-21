import { Eye, FilePlus2, type LucideIcon, PenLine, SendHorizontal, Wrench } from "lucide-react";
import Link from "next/link";

import type { AgentApiAction } from "@/lib/agent/client";
import { FIELD_LABELS, actionCodeLabel, toolLabel } from "@/lib/agent/labels";
import { contentPaths } from "@/lib/content/paths";

import { LocalDateTime } from "./client-ui";

/**
 * "Actions performed" list. Built ONLY from data the server reports (the
 * actions of an API response, or rows of the agent_actions log), never from
 * the assistant's text.
 */

export type ActionItemView = {
  key: string;
  label: string;
  status: "success" | "error" | "skipped";
  kind: "read" | "create" | "update" | "publish_request" | "unknown";
  reason?: string;
  postHref?: string;
  projectHref?: string;
  /** publish_request: the approval page of the pending request. */
  requestHref?: string;
  versionBefore?: number | null;
  versionAfter?: number | null;
  fields?: string[] | null;
  at?: string;
  actor?: string;
  logFailed?: boolean;
};

export function apiActionToView(workspaceId: string, action: AgentApiAction, index: number): ActionItemView {
  const effect = action.effect;
  return {
    key: `${index}-${action.tool}`,
    label: toolLabel(action.tool),
    status: action.status,
    kind: action.kind,
    reason: action.status === "success" ? undefined : (actionCodeLabel(action.code) ?? action.message),
    postHref: effect?.postId ? contentPaths.post(workspaceId, effect.postId) : undefined,
    projectHref: !effect?.postId && effect?.projectId ? contentPaths.project(workspaceId, effect.projectId) : undefined,
    requestHref: effect?.requestId ? `${contentPaths.approvals(workspaceId)}/${effect.requestId}` : undefined,
    versionBefore: effect?.versionBefore,
    versionAfter: effect?.versionAfter,
    fields: effect?.fields,
    logFailed: action.log === "failed",
  };
}

export type AgentLogEntryView = {
  id: string;
  userId: string | null;
  tool: string;
  kind: "read" | "create" | "update" | "publish_request" | "unknown";
  status: "success" | "error" | "skipped";
  errorCode: string | null;
  projectId: string | null;
  postId: string | null;
  versionBefore: number | null;
  versionAfter: number | null;
  fields: string[] | null;
  requestId?: string | null;
  createdAt: string;
};

export function logEntryToView(workspaceId: string, entry: AgentLogEntryView, currentUserId: string): ActionItemView {
  return {
    key: entry.id,
    label: toolLabel(entry.tool),
    status: entry.status,
    kind: entry.kind,
    reason: entry.status === "success" ? undefined : actionCodeLabel(entry.errorCode),
    postHref: entry.postId ? contentPaths.post(workspaceId, entry.postId) : undefined,
    projectHref: !entry.postId && entry.projectId ? contentPaths.project(workspaceId, entry.projectId) : undefined,
    requestHref: entry.requestId ? `${contentPaths.approvals(workspaceId)}/${entry.requestId}` : undefined,
    versionBefore: entry.versionBefore,
    versionAfter: entry.versionAfter,
    fields: entry.fields,
    at: entry.createdAt,
    actor: entry.userId === currentUserId ? "bạn" : entry.userId ? "thành viên khác" : "tài khoản đã xóa",
  };
}

const STATUS_STYLE = {
  success: { text: "Thành công", className: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900" },
  error: { text: "Thất bại", className: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900" },
  skipped: { text: "Bỏ qua", className: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900" },
} as const;

function versionText(item: ActionItemView): string | null {
  if (item.status !== "success") return null;
  if (item.kind === "update" && item.versionBefore && item.versionAfter) {
    return `Phiên bản ${item.versionBefore} → ${item.versionAfter}`;
  }
  if (item.kind === "create" && item.versionAfter) return `Phiên bản ${item.versionAfter} (bản nháp mới)`;
  if (item.kind === "read" && item.versionAfter) return `Đã đọc phiên bản ${item.versionAfter}`;
  // A publish request is only a proposal: never say "published".
  if (item.kind === "publish_request" && item.versionAfter) {
    return `Đã gửi yêu cầu xuất bản phiên bản ${item.versionAfter} — đang chờ chủ sở hữu hoặc quản trị viên duyệt`;
  }
  return null;
}

/** Icon per tool operation kind (visual only). */
const KIND_ICON: Record<ActionItemView["kind"], LucideIcon> = {
  read: Eye,
  create: FilePlus2,
  update: PenLine,
  publish_request: SendHorizontal,
  unknown: Wrench,
};

const STATUS_ACCENT: Record<ActionItemView["status"], string> = {
  success: "bg-emerald-50 text-emerald-600 ring-emerald-100",
  error: "bg-red-50 text-red-600 ring-red-100",
  skipped: "bg-amber-50 text-amber-600 ring-amber-100",
};

export function ActionList({ items, testId = "action-list" }: { items: ActionItemView[]; testId?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-2" data-testid={testId}>
      {items.map((item) => {
        const status = STATUS_STYLE[item.status];
        const version = versionText(item);
        const fields = item.status === "success" && item.fields?.length
          ? `Đã đổi: ${item.fields.map((f) => FIELD_LABELS[f] ?? f).join(", ")}`
          : null;
        return (
          <li
            key={item.key}
            data-testid="action-item"
            data-status={item.status}
            className="flex gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm"
          >
            <span
              className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ${STATUS_ACCENT[item.status]}`}
              aria-hidden
            >
              <KindIcon kind={item.kind} />
            </span>
            <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-slate-900">{item.label}</span>
              <span
                className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${status.className}`}
              >
                {status.text}
              </span>
            </div>
            {item.reason ? <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{item.reason}</p> : null}
            {version || fields ? (
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400" data-testid="action-version">
                {[version, fields].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {item.postHref ? (
                <Link href={item.postHref} className="font-medium text-indigo-600 hover:underline" data-testid="action-post-link">
                  Mở bài viết
                </Link>
              ) : null}
              {item.requestHref ? (
                <Link href={item.requestHref} className="font-medium text-indigo-600 hover:underline" data-testid="action-request-link">
                  Xem yêu cầu chờ duyệt
                </Link>
              ) : null}
              {item.projectHref ? (
                <Link href={item.projectHref} className="font-medium text-indigo-600 hover:underline">
                  Mở dự án
                </Link>
              ) : null}
              {item.at ? (
                <span className="text-slate-500">
                  <LocalDateTime iso={item.at} />
                  {item.actor ? ` · ${item.actor}` : ""}
                </span>
              ) : null}
              {item.logFailed ? <span className="text-amber-700">Chưa ghi được nhật ký</span> : null}
            </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function KindIcon({ kind }: { kind: ActionItemView["kind"] }) {
  const Icon = KIND_ICON[kind] ?? Wrench;
  return <Icon className="h-3.5 w-3.5" />;
}
