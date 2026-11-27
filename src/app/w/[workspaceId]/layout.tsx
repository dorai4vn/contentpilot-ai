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
    <div className="football-shell flex flex-1 flex-col">
      <AppHeader email={user.email} />
      <div className="football-shell-body">
        <WorkspaceNav
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          roleLabel={ROLE_LABELS[workspace.role]}
          pendingCount={pendingCount}
          automationAvailable={process.env.SPORTS_NEWS_WORKSPACE_ID === workspace.id}
        />
        <main id="main-content" className="football-main">{children}</main>
      </div>
    </div>
  );
}
