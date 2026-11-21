"use client";

import { ArrowLeft, Bot, ClipboardCheck, LayoutDashboard, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; icon: LucideIcon; testId: string; match: (path: string) => boolean };

/**
 * Workspace navigation: a vertical sidebar on large screens, a horizontal tab bar
 * on small ones (one element, so every link exists exactly once in the page).
 * Navigation only: it shows a count the server already computed.
 */
export function WorkspaceNav({
  workspaceId,
  workspaceName,
  roleLabel,
  pendingCount,
}: {
  workspaceId: string;
  workspaceName: string;
  roleLabel: string;
  pendingCount: number | null;
}) {
  const pathname = usePathname() ?? "";
  const base = `/w/${workspaceId}`;
  const items: NavItem[] = [
    {
      href: base,
      label: "Tổng quan",
      icon: LayoutDashboard,
      testId: "nav-overview",
      match: (p) => p === base || p.startsWith(`${base}/p/`) || p.startsWith(`${base}/posts/`),
    },
    { href: `${base}/agent`, label: "Trợ lý AI", icon: Bot, testId: "nav-agent", match: (p) => p.startsWith(`${base}/agent`) },
    {
      href: `${base}/approvals`,
      label: "Phê duyệt",
      icon: ClipboardCheck,
      testId: "nav-approvals",
      match: (p) => p.startsWith(`${base}/approvals`),
    },
  ];

  return (
    <aside className="border-b border-slate-200 bg-white lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:w-64 lg:shrink-0 lg:border-r lg:border-b-0">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-4 lg:py-5">
        <div className="hidden lg:block">
          <Link
            href="/dashboard"
            className="mb-4 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Tất cả không gian
          </Link>
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-sm font-semibold text-white"
              aria-hidden
            >
              {workspaceName.trim().charAt(0).toUpperCase() || "W"}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{workspaceName}</p>
              <p className="text-xs text-slate-500">{roleLabel}</p>
            </div>
          </div>
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Không gian làm việc</p>
        </div>

        <nav aria-label="Điều hướng chính" className="-mb-px flex gap-1 overflow-x-auto lg:mb-0 lg:flex-col lg:overflow-visible">
          {items.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                data-testid={item.testId}
                className={`group inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition lg:rounded-lg lg:border-b-0 lg:py-2 ${
                  active
                    ? "border-indigo-600 text-indigo-700 lg:bg-indigo-50"
                    : "border-transparent text-slate-600 hover:text-slate-900 lg:hover:bg-slate-100"
                }`}
              >
                <Icon
                  className={`h-4 w-4 ${active ? "text-indigo-600" : "text-slate-400 group-hover:text-slate-600"}`}
                  aria-hidden
                />
                {item.label}
                {item.testId === "nav-approvals" && pendingCount ? (
                  <span
                    className="ml-auto rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-amber-800"
                    data-testid="nav-approvals-count"
                    aria-label={`${pendingCount} yêu cầu chờ duyệt`}
                  >
                    {pendingCount}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
