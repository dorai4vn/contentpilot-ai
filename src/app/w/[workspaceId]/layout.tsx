import { AppHeader } from "@/app/_components/app-header";
import { countPublishRequests } from "@/lib/content/publish-requests";
import { ROLE_LABELS } from "@/lib/workspaces/labels";

import { WorkspaceNav } from "../_components/workspace-nav";
import { loadWorkspace } from "../_lib/load";

export default async function WorkspaceLayout({ children, params }: LayoutProps<"/w/[workspaceId]">) {
  const { workspaceId } = await params;
  const { user, workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}`);

  // Navigation badge only (read-only count under RLS); the page stays usable if it fails.
  let pendingCount: number | null = null;
  try {
    pendingCount = (await countPublishRequests({ workspaceId: workspace.id })).pending;
  } catch {
    pendingCount = null;
  }

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader email={user.email} />
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col lg:flex-row">
        <WorkspaceNav
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          roleLabel={ROLE_LABELS[workspace.role]}
          pendingCount={pendingCount}
        />
        <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
