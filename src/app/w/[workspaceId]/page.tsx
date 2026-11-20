import type { Metadata } from "next";
import Link from "next/link";

import { listProjects } from "@/lib/content/projects";
import { ROLE_LABELS } from "@/lib/workspaces/labels";

import { CreateProjectForm, ProjectCard } from "../_components/project-forms";
import { Badge, Breadcrumbs, Card, EmptyState, Notice } from "../_components/ui";
import { loadWorkspace } from "../_lib/load";

export const metadata: Metadata = { title: "Không gian làm việc" };

export default async function WorkspacePage({ params, searchParams }: PageProps<"/w/[workspaceId]">) {
  const { workspaceId } = await params;
  const { view } = await searchParams;
  const showArchived = view === "archived";

  const { workspace, permissions } = await loadWorkspace(workspaceId, `/w/${workspaceId}`);
  const all = await listProjects({ workspaceId: workspace.id, includeArchived: true });
  const projects = all.filter((p) => (p.archivedAt !== null) === showArchived);
  const archivedCount = all.filter((p) => p.archivedAt !== null).length;

  const tab = (active: boolean) =>
    `whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${
      active
        ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white"
        : "text-slate-600 hover:text-slate-900 dark:text-slate-400"
    }`;

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs items={[{ label: "Bảng điều khiển", href: "/dashboard" }, { label: workspace.name }]} />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="workspace-title">
            {workspace.name}
          </h1>
          <Badge tone="indigo">{ROLE_LABELS[workspace.role]}</Badge>
        </div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Các dự án nội dung trong không gian làm việc này.</p>
      </div>

      {permissions.manageProjects ? (
        <Card>
          <h2 className="mb-3 font-semibold">Dự án mới</h2>
          <CreateProjectForm workspaceId={workspace.id} />
        </Card>
      ) : (
        <Notice tone="info" testId="member-notice">
          Bạn là thành viên của không gian làm việc này: bạn có thể mở dự án và viết bài. Chỉ chủ sở hữu và quản trị
          viên mới được tạo, đổi tên hoặc lưu trữ dự án.
        </Notice>
      )}

      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Dự án</h2>
          <nav className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 dark:bg-slate-900" aria-label="Lọc dự án">
            <Link href={`/w/${workspace.id}`} className={tab(!showArchived)} aria-current={!showArchived ? "page" : undefined}>
              Đang hoạt động
            </Link>
            <Link
              href={`/w/${workspace.id}?view=archived`}
              className={tab(showArchived)}
              aria-current={showArchived ? "page" : undefined}
              data-testid="archived-projects-tab"
            >
              Đã lưu trữ{archivedCount ? ` (${archivedCount})` : ""}
            </Link>
          </nav>
        </div>

        {projects.length === 0 ? (
          <EmptyState title={showArchived ? "Chưa có dự án nào được lưu trữ" : "Chưa có dự án nào"}>
            {showArchived
              ? "Dự án đã lưu trữ sẽ hiện ở đây và có thể khôi phục."
              : permissions.manageProjects
                ? "Hãy tạo dự án đầu tiên ở phía trên."
                : "Chủ sở hữu hoặc quản trị viên có thể tạo dự án đầu tiên."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800" data-testid="project-list">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                canManage={permissions.manageProjects}
                project={{
                  id: project.id,
                  workspaceId: project.workspaceId,
                  name: project.name,
                  description: project.description,
                  archivedAt: project.archivedAt,
                  updatedAt: project.updatedAt,
                }}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
