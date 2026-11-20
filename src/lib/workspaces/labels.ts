import type { WorkspaceRole } from "@/types/database";

/** Vietnamese names of workspace roles, shared by every page that shows a role. */
export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Chủ sở hữu",
  admin: "Quản trị viên",
  member: "Thành viên",
};
