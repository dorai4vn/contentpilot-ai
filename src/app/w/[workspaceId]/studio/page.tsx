import { Bot, CheckCircle2, ClipboardCheck, FileText, FolderKanban, FolderPlus, LayoutDashboard, PenLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { contentPaths } from "@/lib/content/paths";
import { listPosts } from "@/lib/content/posts";
import { listProjects } from "@/lib/content/projects";
import { countPublishRequests } from "@/lib/content/publish-requests";
import { ROLE_LABELS } from "@/lib/workspaces/labels";

import { CreateProjectForm, ProjectCard } from "../../_components/project-forms";
import { Badge, Breadcrumbs, Card, EmptyState, Notice, PageHeader, StatCard, buttonClass, segmentClass } from "../../_components/ui";
import { loadWorkspace } from "../../_lib/load";

type PostCounts = { total: number; draft: number; ready: number; published: number };

/** Real post counts of the active projects (read-only, RLS). Null when they cannot be loaded. */
async function countActivePosts(projectIds: string[]): Promise<PostCounts | null> {
  try {
    const lists = await Promise.all(projectIds.map((projectId) => listPosts({ projectId })));
    const counts: PostCounts = { total: 0, draft: 0, ready: 0, published: 0 };
    for (const post of lists.flat()) {
      counts.total += 1;
      counts[post.status] += 1;
    }
    return counts;
  } catch {
    return null;
  }
}

export const metadata: Metadata = { title: "Không gian làm việc" };

export default async function WorkspacePage({ params, searchParams }: PageProps<"/w/[workspaceId]/studio">) {
  const { workspaceId } = await params;
  const { view } = await searchParams;
  const showArchived = view === "archived";

  const { workspace, permissions } = await loadWorkspace(workspaceId, `/w/${workspaceId}`);
  const [all, requestCounts] = await Promise.all([
    listProjects({ workspaceId: workspace.id, includeArchived: true }),
    countPublishRequests({ workspaceId: workspace.id }),
  ]);
  const pendingCount = requestCounts.pending;
  const projects = all.filter((p) => (p.archivedAt !== null) === showArchived);
  const archivedCount = all.filter((p) => p.archivedAt !== null).length;
  const activeProjects = all.filter((p) => p.archivedAt === null);
  const postCounts = await countActivePosts(activeProjects.map((p) => p.id));

  const tab = segmentClass;

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs items={[{ label: "Bảng điều khiển", href: "/dashboard" }, { label: workspace.name }]} />
        <PageHeader
          icon={LayoutDashboard}
          title={workspace.name}
          titleTestId="workspace-title"
          badge={<Badge tone="indigo">{ROLE_LABELS[workspace.role]}</Badge>}
          description="Tổng quan nội dung, yêu cầu xuất bản và các dự án trong không gian làm việc này."
          actions={
            <nav className="flex flex-wrap gap-2" aria-label="Điều hướng không gian làm việc">
              <Link href={contentPaths.approvals(workspace.id)} className={buttonClass.secondary} data-testid="open-approvals">
                <ClipboardCheck className="h-4 w-4 text-slate-500" aria-hidden />
                Phê duyệt
                {pendingCount ? (
                  <span
                    className="ml-1 rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-800"
                    data-testid="approvals-pending-count"
                  >
                    {pendingCount}
                  </span>
                ) : null}
              </Link>
              <Link href={`/w/${workspace.id}/agent`} className={buttonClass.primary} data-testid="open-agent">
                <Bot className="h-4 w-4" aria-hidden />
                Trợ lý AI
              </Link>
            </nav>
          }
        />
      </div>

      <section aria-label="Số liệu" className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="workspace-kpis">
        <StatCard
          label="Dự án đang hoạt động"
          value={activeProjects.length}
          icon={FolderKanban}
          tone="indigo"
          hint={archivedCount ? `${archivedCount} dự án đã lưu trữ` : "Chưa có dự án lưu trữ"}
          testId="kpi-projects"
        />
        <StatCard
          label="Bài viết"
          value={postCounts?.total ?? null}
          icon={FileText}
          hint={
            postCounts
              ? `${postCounts.draft} bản nháp · ${postCounts.ready} sẵn sàng`
              : "Chưa tải được số bài viết"
          }
          testId="kpi-posts"
        />
        <StatCard
          label="Chờ duyệt"
          value={pendingCount}
          icon={ClipboardCheck}
          tone="amber"
          hint="Yêu cầu xuất bản đang chờ quyết định"
          href={contentPaths.approvals(workspace.id)}
          testId="kpi-pending"
        />
        <StatCard
          label="Đã xuất bản"
          value={postCounts?.published ?? null}
          icon={CheckCircle2}
          tone="emerald"
          hint={`${requestCounts.approved} yêu cầu đã được duyệt`}
          testId="kpi-published"
        />
      </section>

      <section aria-label="Thao tác nhanh" className="grid gap-3 sm:grid-cols-3">
        {permissions.manageProjects ? (
          <a
            href="#new-project"
            className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-card transition hover:border-indigo-200 hover:shadow-raised"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <FolderPlus className="h-4 w-4" aria-hidden />
            </span>
            <span>
              <span className="block text-sm font-medium text-slate-900">Tạo dự án mới</span>
              <span className="block text-xs text-slate-500">Nhóm bài viết theo chiến dịch</span>
            </span>
          </a>
        ) : null}
        <Link
          href={`/w/${workspace.id}/agent`}
          className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-card transition hover:border-indigo-200 hover:shadow-raised"
        >
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
            <PenLine className="h-4 w-4" aria-hidden />
          </span>
          <span>
            <span className="block text-sm font-medium text-slate-900">Soạn nháp cùng Trợ lý AI</span>
            <span className="block text-xs text-slate-500">AI chỉ tạo bản nháp, không tự xuất bản</span>
          </span>
        </Link>
        <Link
          href={contentPaths.approvals(workspace.id)}
          className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-card transition hover:border-amber-200 hover:shadow-raised"
        >
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
            <ClipboardCheck className="h-4 w-4" aria-hidden />
          </span>
          <span>
            <span className="block text-sm font-medium text-slate-900">Xem hàng chờ phê duyệt</span>
            <span className="block text-xs text-slate-500">
              {pendingCount ? `${pendingCount} yêu cầu đang chờ` : "Không có yêu cầu nào đang chờ"}
            </span>
          </span>
        </Link>
      </section>

      {permissions.manageProjects ? (
        <Card id="new-project" className="scroll-mt-20">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <FolderPlus className="h-4 w-4 text-indigo-600" aria-hidden />
            Dự án mới
          </h2>
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
          <h2 className="flex items-center gap-2 font-semibold">
            <FolderKanban className="h-4 w-4 text-slate-500" aria-hidden />
            Dự án
          </h2>
          <nav className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1" aria-label="Lọc dự án">
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
          <ul className="divide-y divide-slate-100" data-testid="project-list">
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
