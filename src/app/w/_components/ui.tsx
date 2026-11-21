import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Info,
  Inbox,
  type LucideIcon,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import type { ContentPostStatus } from "@/types/database";

/**
 * Presentational building blocks shared by every page (Modern SaaS light theme:
 * slate surfaces, indigo #4F46E5 primary, 10–14px radius, soft shadows).
 * Pure styling: no data access, no behaviour.
 */

export const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs outline-none transition placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

const buttonBase =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-y-0";

export const buttonClass = {
  primary: `${buttonBase} bg-indigo-600 text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-500`,
  secondary: `${buttonBase} border border-slate-200 bg-white text-slate-700 shadow-xs hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900`,
  ghost: `${buttonBase} text-slate-600 hover:bg-slate-100 hover:text-slate-900`,
  warning: `${buttonBase} border border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100`,
  danger: `${buttonBase} border border-red-200 bg-white text-red-700 shadow-xs hover:bg-red-50`,
} as const;

export function Card({ className = "", ...props }: ComponentProps<"section">) {
  return <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-card ${className}`} {...props} />;
}

/** Page title block: optional icon, title, description and actions on the right. */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  titleTestId,
  badge,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  titleTestId?: string;
  badge?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {Icon ? (
          <span className="mt-0.5 hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100 sm:inline-flex">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900" data-testid={titleTestId}>
              {title}
            </h1>
            {badge}
          </div>
          {description ? <div className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">{description}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** KPI tile. `value` must come from real data; `null` renders an explicit dash. */
export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "slate",
  hint,
  href,
  testId,
}: {
  label: string;
  value: number | null;
  icon: LucideIcon;
  tone?: "slate" | "indigo" | "amber" | "emerald";
  hint?: ReactNode;
  href?: string;
  testId?: string;
}) {
  const tones = {
    slate: "bg-slate-100 text-slate-600",
    indigo: "bg-indigo-50 text-indigo-600",
    amber: "bg-amber-50 text-amber-600",
    emerald: "bg-emerald-50 text-emerald-600",
  };
  const body = (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-600">{label}</p>
        <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${tones[tone]}`}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 tabular-nums" data-testid={testId}>
        {value === null ? "—" : value.toLocaleString("vi-VN")}
      </p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </>
  );
  const className = "block rounded-xl border border-slate-200 bg-white p-4 shadow-card";
  return href ? (
    <Link href={href} className={`${className} transition hover:border-indigo-200 hover:shadow-raised`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-slate-700">
      {children}
    </label>
  );
}

export function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-600">
      {message}
    </p>
  );
}

const statusStyle: Record<ContentPostStatus, { badge: string; dot: string }> = {
  draft: { badge: "bg-slate-100 text-slate-700 ring-slate-200", dot: "bg-slate-400" },
  ready: { badge: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  published: { badge: "bg-indigo-50 text-indigo-700 ring-indigo-200", dot: "bg-indigo-500" },
};

/** Vietnamese status names, shared by badges, filters and history. */
export const STATUS_LABELS: Record<ContentPostStatus, string> = {
  draft: "Bản nháp",
  ready: "Sẵn sàng",
  published: "Đã xuất bản",
};

export function StatusBadge({ status }: { status: ContentPostStatus }) {
  const style = statusStyle[status];
  return (
    <span
      data-testid="status-badge"
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "indigo" | "amber" | "emerald" | "red";
}) {
  const tones = {
    neutral: "bg-slate-100 text-slate-700 ring-slate-200",
    indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    red: "bg-red-50 text-red-700 ring-red-200",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({ title, children, icon: Icon = Inbox }: { title: string; children?: ReactNode; icon?: LucideIcon }) {
  return (
    <div
      data-testid="empty-state"
      className="flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-10 text-center"
    >
      <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-400 shadow-card ring-1 ring-slate-200">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <p className="font-medium text-slate-900">{title}</p>
      {children ? <div className="mt-1 max-w-md text-sm text-slate-600">{children}</div> : null}
    </div>
  );
}

const noticeIcons = { info: Info, success: CheckCircle2, error: XCircle, warning: AlertTriangle } as const;

export function Notice({
  tone,
  children,
  testId,
}: {
  tone: "info" | "success" | "error" | "warning";
  children: ReactNode;
  testId?: string;
}) {
  const tones = {
    info: "border-slate-200 bg-slate-50 text-slate-700 [&>svg]:text-slate-500",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800 [&>svg]:text-emerald-600",
    error: "border-red-200 bg-red-50 text-red-800 [&>svg]:text-red-600",
    warning: "border-amber-200 bg-amber-50 text-amber-900 [&>svg]:text-amber-600",
  };
  const Icon = noticeIcons[tone];
  return (
    <div
      data-testid={testId}
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-6 ${tones[tone]}`}
    >
      <Icon className="mt-1 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Đường dẫn" className="mb-3 text-sm text-slate-500">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden /> : null}
            {item.href ? (
              <Link href={item.href} className="truncate rounded px-1 hover:bg-slate-100 hover:text-slate-900">
                {item.label}
              </Link>
            ) : (
              <span className="truncate px-1 font-medium text-slate-900" aria-current="page">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-200/70 ${className}`} />;
}

/** Segmented-control tab style shared by filter bars. */
export function segmentClass(active: boolean) {
  return `inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition ${
    active ? "bg-white text-slate-900 shadow-card ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-900"
  }`;
}
