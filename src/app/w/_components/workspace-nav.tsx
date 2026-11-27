"use client";

import { ArrowLeft, Bot, ClipboardCheck, LayoutDashboard, Newspaper, PanelsTopLeft, Settings2, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; icon: LucideIcon; testId: string; match: (path: string) => boolean };

export function WorkspaceNav({ workspaceId, workspaceName, roleLabel, pendingCount, automationAvailable }: {
  workspaceId: string;
  workspaceName: string;
  roleLabel: string;
  pendingCount: number | null;
  automationAvailable: boolean;
}) {
  const pathname = usePathname() ?? "";
  const base = `/w/${workspaceId}`;
  const newsItems: NavItem[] = [
    { href: base, label: "Tổng quan", icon: LayoutDashboard, testId: "nav-overview", match: (path) => path === base },
    { href: `${base}/news`, label: "Luồng tin", icon: Newspaper, testId: "nav-news", match: (path) => path.startsWith(`${base}/news`) },
    { href: `${base}/approvals`, label: "Chờ duyệt", icon: ClipboardCheck, testId: "nav-approvals", match: (path) => path.startsWith(`${base}/approvals`) },
    ...(automationAvailable ? [{ href: `${base}/automation`, label: "Tự động hóa", icon: Settings2, testId: "nav-automation", match: (path: string) => path.startsWith(`${base}/automation`) }] : []),
  ];
  const studioItems: NavItem[] = [
    { href: `${base}/studio`, label: "Nội dung", icon: PanelsTopLeft, testId: "nav-studio", match: (path) => path.startsWith(`${base}/studio`) || path.startsWith(`${base}/p/`) || path.startsWith(`${base}/posts/`) },
    { href: `${base}/agent`, label: "Trợ lý AI", icon: Bot, testId: "nav-agent", match: (path) => path.startsWith(`${base}/agent`) },
  ];

  function links(items: NavItem[]) {
    return items.map(({ href, label, icon: Icon, testId, match }) => {
      const active = match(pathname);
      return (
        <Link key={href} href={href} aria-current={active ? "page" : undefined} data-testid={testId}
          className={`football-nav-link ${active ? "is-active" : ""}`}>
          <Icon size={18} aria-hidden="true" /><span>{label}</span>
          {testId === "nav-approvals" && pendingCount ? <span className="football-nav-count" data-testid="nav-approvals-count" aria-label={`${pendingCount} yêu cầu chờ duyệt`}>{pendingCount}</span> : null}
        </Link>
      );
    });
  }

  return (
    <aside className="football-sidebar">
      <div className="football-sidebar-inner">
        <Link href="/dashboard" className="football-back"><ArrowLeft size={15} aria-hidden="true" /> Không gian làm việc</Link>
        <div className="football-workspace"><span className="football-workspace-mark" aria-hidden="true">{workspaceName.trim().charAt(0).toUpperCase() || "W"}</span><span><strong>{workspaceName}</strong><small>{roleLabel}</small></span></div>
        <nav aria-label="Điều hướng chính" className="football-navigation">
          <div className="football-nav-group"><p>Bóng đá</p>{links(newsItems)}</div>
          <div className="football-nav-group"><p>Content Studio</p>{links(studioItems)}</div>
        </nav>
      </div>
    </aside>
  );
}
