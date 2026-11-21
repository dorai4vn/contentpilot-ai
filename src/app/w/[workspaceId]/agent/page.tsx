import { Activity, Bot, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { type AgentActionLogEntry, listAgentActions } from "@/lib/agent/actions-log";
import { isAgentConfigured } from "@/lib/agent/config";
import { contentPaths } from "@/lib/content/paths";
import { listProjects } from "@/lib/content/projects";
import { uuidSchema } from "@/lib/validation/content";

import { ActionList, logEntryToView } from "../../_components/agent-actions";
import { AgentChat } from "../../_components/agent-chat";
import { Breadcrumbs, Card, EmptyState, Notice, PageHeader } from "../../_components/ui";
import { loadWorkspace } from "../../_lib/load";

export const metadata: Metadata = { title: "Trợ lý AI" };

export default async function AgentPage({ params, searchParams }: PageProps<"/w/[workspaceId]/agent">) {
  const { workspaceId } = await params;
  const { project } = await searchParams;
  const { user, workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/agent`);

  const configured = isAgentConfigured();
  const projects = await listProjects({ workspaceId: workspace.id });
  const requestedProject = uuidSchema.safeParse(project);
  const initialProjectId =
    requestedProject.success && projects.some((p) => p.id === requestedProject.data) ? requestedProject.data : null;

  // Recent activity from agent_actions (RLS: members of this workspace only).
  let recent: AgentActionLogEntry[] | null;
  try {
    recent = await listAgentActions({ workspaceId: workspace.id, limit: 20 });
  } catch {
    recent = null;
  }

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          items={[
            { label: "Bảng điều khiển", href: "/dashboard" },
            { label: workspace.name, href: contentPaths.workspace(workspace.id) },
            { label: "Trợ lý AI" },
          ]}
        />
        <PageHeader
          icon={Bot}
          title="Trợ lý AI"
          titleTestId="agent-title"
          description="Nhờ Trợ lý đọc dự án và bài viết, tạo bài nháp mới, chỉnh sửa bài đang ở trạng thái Bản nháp hoặc gửi yêu cầu xuất bản. Trợ lý không thể tự xuất bản, phê duyệt, xóa hay đổi trạng thái bài viết: mọi yêu cầu xuất bản đều chờ chủ sở hữu hoặc quản trị viên duyệt."
        />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="min-w-0">
          {configured ? (
            <div className="space-y-4">
              <Notice tone="info" testId="agent-privacy-notice">
                Tin nhắn của bạn và nội dung các bài viết mà Trợ lý đọc sẽ được gửi tới OpenAI để xử lý. Không nhập mật
                khẩu hay thông tin nhạy cảm. Cuộc trò chuyện chỉ được giữ trong tab trình duyệt này.
              </Notice>
              <AgentChat
                workspaceId={workspace.id}
                projects={projects.map((p) => ({ id: p.id, name: p.name }))}
                initialProjectId={initialProjectId}
              />
            </div>
          ) : (
            <EmptyState title="Trợ lý AI chưa sẵn sàng">
              Tính năng này chưa được cấu hình trên hệ thống. Quản trị viên cần thiết lập kết nối OpenAI phía máy chủ;
              trong lúc chờ, bạn vẫn có thể quản lý nội dung như bình thường.
            </EmptyState>
          )}
        </Card>

        <aside className="min-w-0 space-y-6">
          <Card>
            <h2 className="mb-1 flex items-center gap-2 font-semibold">
              <Activity className="h-4 w-4 text-indigo-600" aria-hidden />
              Hoạt động AI gần đây
            </h2>
            <p className="mb-4 text-xs text-slate-500">
              Ghi lại từ máy chủ sau mỗi thao tác của Trợ lý, không dựa vào câu trả lời của AI.
            </p>
            {recent === null ? (
              <Notice tone="warning" testId="agent-activity-error">
                Chưa tải được nhật ký hoạt động. Vui lòng thử lại sau.
              </Notice>
            ) : recent.length === 0 ? (
              <p className="text-sm text-slate-500" data-testid="agent-activity-empty">
                Chưa có hoạt động nào.
              </p>
            ) : (
              <ActionList
                testId="agent-activity"
                items={recent.map((entry) => logEntryToView(workspace.id, entry, user.id))}
              />
            )}
          </Card>

          <Card>
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden />
              Giới hạn an toàn
            </h2>
            <ul className="space-y-2.5 text-sm text-slate-600">
              {[
                "Bài viết do Trợ lý tạo luôn là Bản nháp.",
                "Trợ lý chỉ sửa bài ở trạng thái Bản nháp và luôn đọc bài trước khi sửa.",
                "Nếu bài vừa bị người khác sửa, Trợ lý dừng lại thay vì ghi đè.",
                "Trợ lý chỉ gửi yêu cầu xuất bản; con người quyết định phê duyệt.",
                "Mỗi yêu cầu tối đa 6 lần gọi công cụ và 3 thao tác ghi.",
              ].map((rule) => (
                <li key={rule} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}
