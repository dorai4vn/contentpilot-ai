import type { Metadata } from "next";
import Link from "next/link";

import { listProjects } from "@/lib/content/projects";

import { CreateProjectForm, ProjectCard } from "../_components/project-forms";
import { Badge, Breadcrumbs, Card, EmptyState, Notice } from "../_components/ui";
import { loadWorkspace } from "../_lib/load";

export const metadata: Metadata = { title: "Workspace" };

const roleLabel = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export default async function WorkspacePage({ params, searchParams }: PageProps<"/w/[workspaceId]">) {
  const { workspaceId } = await params;
  const { view } = await searchParams;
  const showArchived = view === "archived";

  const { workspace, permissions } = await loadWorkspace(workspaceId, `/w/${workspaceId}`);
  const all = await listProjects({ workspaceId: workspace.id, includeArchived: true });
  const projects = all.filter((p) => (p.archivedAt !== null) === showArchived);
  const archivedCount = all.filter((p) => p.archivedAt !== null).length;

  const tab = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${
      active
        ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white"
        : "text-slate-600 hover:text-slate-900 dark:text-slate-400"
    }`;

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs items={[{ label: "Dashboard", href: "/dashboard" }, { label: workspace.name }]} />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="workspace-title">
            {workspace.name}
          </h1>
          <Badge tone="indigo">{roleLabel[workspace.role]}</Badge>
        </div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Content projects in this workspace.</p>
      </div>

      {permissions.manageProjects ? (
        <Card>
          <h2 className="mb-3 font-semibold">New project</h2>
          <CreateProjectForm workspaceId={workspace.id} />
        </Card>
      ) : (
        <Notice tone="info" testId="member-notice">
          You are a member of this workspace: you can open projects and write posts. Only owners and admins can
          create, rename or archive projects.
        </Notice>
      )}

      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Projects</h2>
          <nav className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900" aria-label="Project filter">
            <Link href={`/w/${workspace.id}`} className={tab(!showArchived)} aria-current={!showArchived ? "page" : undefined}>
              Active
            </Link>
            <Link
              href={`/w/${workspace.id}?view=archived`}
              className={tab(showArchived)}
              aria-current={showArchived ? "page" : undefined}
              data-testid="archived-projects-tab"
            >
              Archived{archivedCount ? ` (${archivedCount})` : ""}
            </Link>
          </nav>
        </div>

        {projects.length === 0 ? (
          <EmptyState title={showArchived ? "No archived projects" : "No projects yet"}>
            {showArchived
              ? "Archived projects appear here and can be restored."
              : permissions.manageProjects
                ? "Create your first project above."
                : "An owner or admin can create the first project."}
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
