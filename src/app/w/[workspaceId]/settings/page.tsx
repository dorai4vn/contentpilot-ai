import { Settings } from "lucide-react";
import type { Metadata } from "next";

import { ROLE_LABELS } from "@/lib/workspaces/labels";

import { Card, PageHeader } from "../../_components/ui";
import { loadWorkspace } from "../../_lib/load";
import { RenameWorkspaceForm } from "./rename-workspace-form";

export const metadata: Metadata = { title: "Cài đặt không gian làm việc" };

export default async function WorkspaceSettingsPage({ params }: PageProps<"/w/[workspaceId]/settings">) {
  const { workspaceId } = await params;
  const { workspace, permissions } = await loadWorkspace(workspaceId, `/w/${workspaceId}/settings`);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Settings}
        title="Cài đặt"
        description={`Vai trò của bạn: ${ROLE_LABELS[workspace.role]}. Đổi tên không làm thay đổi liên kết, dữ liệu hay thành viên.`}
      />
      <Card>
        <RenameWorkspaceForm
          key={workspace.name}
          workspaceId={workspace.id}
          currentName={workspace.name}
          canEdit={permissions.manageWorkspace}
        />
      </Card>
    </div>
  );
}
