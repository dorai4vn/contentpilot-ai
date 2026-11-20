import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { contentPaths } from "@/lib/content/paths";
import { getPost, getPostHistory } from "@/lib/content/posts";
import { getProject } from "@/lib/content/projects";

import { LocalDateTime } from "../../../_components/client-ui";
import { ArchivePostButton, type EditablePost, PostEditor, StatusSwitch } from "../../../_components/post-forms";
import { Badge, Breadcrumbs, Card, Notice, StatusBadge } from "../../../_components/ui";
import { loadWorkspace, routeId } from "../../../_lib/load";

export const metadata: Metadata = { title: "Editor" };

export default async function PostEditorPage({ params }: PageProps<"/w/[workspaceId]/posts/[postId]">) {
  const { workspaceId, postId: postParam } = await params;
  const { user, workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/posts/${postParam}`);

  const postId = routeId(postParam);
  const [post, history] = await Promise.all([getPost({ postId }), getPostHistory({ postId })]);
  if (!post || post.workspaceId !== workspace.id) notFound();
  const project = await getProject({ projectId: post.projectId });
  if (!project) notFound();

  const projectArchived = project.archivedAt !== null;
  const postArchived = post.archivedAt !== null;
  const readOnly = postArchived || projectArchived;

  const editable: EditablePost = {
    id: post.id,
    workspaceId: post.workspaceId,
    projectId: post.projectId,
    title: post.title,
    body: post.body,
    status: post.status,
    scheduledFor: post.scheduledFor,
    version: post.version,
    archivedAt: post.archivedAt,
  };

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          items={[
            { label: "Dashboard", href: "/dashboard" },
            { label: workspace.name, href: contentPaths.workspace(workspace.id) },
            { label: project.name, href: contentPaths.project(workspace.id, project.id) },
            { label: post.title },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight" data-testid="post-heading">
            {post.title}
          </h1>
          <StatusBadge status={post.status} />
          {postArchived ? <Badge tone="amber">Archived</Badge> : null}
          <span className="text-sm text-slate-500" data-testid="post-version">
            Version {post.version}
          </span>
        </div>
      </div>

      {postArchived ? (
        <Notice tone="warning" testId="post-archived-notice">
          This post is archived and read-only. Restore it to edit.
        </Notice>
      ) : projectArchived ? (
        <Notice tone="warning" testId="post-archived-notice">
          The project is archived, so this post is read-only.
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <PostEditor post={editable} readOnly={readOnly} />
        </Card>

        <aside className="space-y-6">
          <Card>
            <h2 className="mb-1 font-semibold">Status</h2>
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
              {post.status === "ready"
                ? "Ready for review. Publishing becomes available later, with human approval."
                : "Draft: still being written."}
            </p>
            {readOnly ? null : <StatusSwitch key={`status-${post.version}`} post={editable} />}
          </Card>

          <Card>
            <h2 className="mb-1 font-semibold">Archive</h2>
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
              Archived posts are kept with their history and can be restored. Nothing is deleted.
            </p>
            <ArchivePostButton key={`archive-${post.version}`} post={editable} projectArchived={projectArchived} />
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold">Version history</h2>
            {history.length === 0 ? (
              <p className="text-sm text-slate-500">No history yet.</p>
            ) : (
              <ol className="space-y-3" data-testid="version-history">
                {history.map((v, index) => {
                  const previous = history[index + 1];
                  const changes = previous
                    ? [
                        v.title !== previous.title ? "title" : null,
                        v.body !== previous.body ? "content" : null,
                        v.status !== previous.status ? `status → ${v.status}` : null,
                        v.scheduledFor !== previous.scheduledFor ? "schedule" : null,
                        (v.archivedAt === null) !== (previous.archivedAt === null)
                          ? v.archivedAt
                            ? "archived"
                            : "restored"
                          : null,
                      ].filter(Boolean)
                    : ["created"];
                  return (
                    <li key={v.id} className="border-l-2 border-slate-200 pl-3 dark:border-slate-700" data-testid="version-item">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium">v{v.version}</span>
                        <StatusBadge status={v.status} />
                        {v.changeSource === "agent" ? <Badge tone="indigo">AI</Badge> : null}
                      </div>
                      <p className="text-xs text-slate-500">
                        <LocalDateTime iso={v.createdAt} /> ·{" "}
                        {v.changedBy === user.id ? "you" : v.changedBy ? "another member" : "deleted account"}
                      </p>
                      <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="version-changes">
                        {changes.length ? changes.join(", ") : "no content change"}
                      </p>
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-slate-500 hover:text-slate-700">View this version</summary>
                        <p className="mt-1 font-medium">{v.title}</p>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono dark:bg-slate-900">
                          {v.body || "(empty)"}
                        </pre>
                      </details>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
