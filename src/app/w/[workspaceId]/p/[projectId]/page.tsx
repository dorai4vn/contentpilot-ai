import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { contentPaths } from "@/lib/content/paths";
import { listPosts } from "@/lib/content/posts";
import { getProject } from "@/lib/content/projects";

import { LocalDateTime } from "../../../_components/client-ui";
import { CreatePostForm } from "../../../_components/post-forms";
import { Badge, Breadcrumbs, Card, EmptyState, Notice, StatusBadge, buttonClass } from "../../../_components/ui";
import { loadWorkspace, routeId } from "../../../_lib/load";

export const metadata: Metadata = { title: "Dự án" };

const FILTERS = [
  { key: "all", label: "Tất cả" },
  { key: "draft", label: "Bản nháp" },
  { key: "ready", label: "Sẵn sàng" },
  { key: "archived", label: "Đã lưu trữ" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

function parseFilter(value: string | string[] | undefined): FilterKey {
  return FILTERS.some((f) => f.key === value) ? (value as FilterKey) : "all";
}

export default async function ProjectPage({ params, searchParams }: PageProps<"/w/[workspaceId]/p/[projectId]">) {
  const { workspaceId, projectId: projectParam } = await params;
  const filter = parseFilter((await searchParams).filter);
  const { workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/p/${projectParam}`);

  const projectId = routeId(projectParam);
  const project = await getProject({ projectId });
  if (!project || project.workspaceId !== workspace.id) notFound();

  const posts = await listPosts({
    projectId: project.id,
    ...(filter === "draft" || filter === "ready" ? { status: filter } : {}),
    includeArchived: filter === "archived",
  });
  const visible = filter === "archived" ? posts.filter((p) => p.archivedAt !== null) : posts;
  const projectArchived = project.archivedAt !== null;
  const base = contentPaths.project(workspace.id, project.id);

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          items={[
            { label: "Bảng điều khiển", href: "/dashboard" },
            { label: workspace.name, href: contentPaths.workspace(workspace.id) },
            { label: project.name },
          ]}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="project-title">
              {project.name}
            </h1>
            {projectArchived ? <Badge tone="amber">Đã lưu trữ</Badge> : null}
          </div>
          <Link
            href={`/w/${workspace.id}/agent?project=${project.id}`}
            className={buttonClass.secondary}
            data-testid="open-agent"
          >
            ✦ Trợ lý AI
          </Link>
        </div>
        {project.description ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{project.description}</p>
        ) : null}
      </div>

      {projectArchived ? (
        <Notice tone="warning" testId="project-archived-notice">
          Dự án này đã được lưu trữ: các bài viết chỉ có thể xem và không thể thêm bài mới.
        </Notice>
      ) : (
        <Card>
          <details className="group">
            <summary className="cursor-pointer list-none font-semibold" data-testid="new-post-toggle">
              <span className="inline-flex items-center gap-2">
                <span className="text-indigo-600 group-open:rotate-45 transition-transform" aria-hidden>
                  +
                </span>
                Bài viết mới
              </span>
            </summary>
            <div className="mt-4">
              <CreatePostForm workspaceId={workspace.id} projectId={project.id} />
            </div>
          </details>
        </Card>
      )}

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Bài viết</h2>
          <nav className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 dark:bg-slate-900" aria-label="Lọc bài viết">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={f.key === "all" ? base : `${base}?filter=${f.key}`}
                aria-current={filter === f.key ? "page" : undefined}
                data-testid={`filter-${f.key}`}
                className={`whitespace-nowrap rounded-md px-2 py-1.5 text-xs font-medium sm:px-3 sm:text-sm ${
                  filter === f.key
                    ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400"
                }`}
              >
                {f.label}
              </Link>
            ))}
          </nav>
        </div>

        {visible.length === 0 ? (
          <EmptyState title={filter === "all" ? "Chưa có bài viết nào" : "Không có bài viết nào phù hợp với bộ lọc"}>
            {filter === "all" && !projectArchived ? "Dùng “Bài viết mới” ở trên để viết bài đầu tiên." : null}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800" data-testid="post-list">
            {visible.map((post) => (
              <li key={post.id} className="py-3" data-testid="post-item">
                <Link
                  href={contentPaths.post(workspace.id, post.id)}
                  className="group flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium group-hover:text-indigo-600" data-testid="post-title">
                      {post.title}
                    </p>
                    <p className="text-xs text-slate-500">
                      Phiên bản {post.version} · cập nhật lúc <LocalDateTime iso={post.updatedAt} />
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-sm">
                    <span className="text-slate-600 dark:text-slate-400" data-testid="post-schedule">
                      {post.scheduledFor ? (
                        <>
                          Dự kiến đăng <LocalDateTime iso={post.scheduledFor} />
                        </>
                      ) : (
                        <span className="text-slate-400">Chưa lên lịch</span>
                      )}
                    </span>
                    {post.archivedAt ? <Badge tone="amber">Đã lưu trữ</Badge> : null}
                    <StatusBadge status={post.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {visible.length >= 200 ? (
          <p className="mt-3 text-xs text-slate-500">Đang hiển thị 200 bài viết được cập nhật gần nhất.</p>
        ) : null}
      </Card>
    </div>
  );
}
