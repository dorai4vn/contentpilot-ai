import { AlertTriangle, Clock3, Power } from "lucide-react";
import type { Metadata } from "next";

import { sportsControlTarget } from "@/lib/sports-news/control-target";
import { createClient } from "@/lib/supabase/server";

import { loadWorkspace } from "../../_lib/load";
import { emergencyStop, enableAutomation, resetScoring, saveScoring } from "./actions";

export const metadata: Metadata = { title: "Tự động hóa" };

export default async function AutomationPage({ params, searchParams }: PageProps<"/w/[workspaceId]/automation">) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/automation`);
  const target = sportsControlTarget(workspace.id);
  if (!target) return <div className="football-page"><h1 className="text-2xl font-bold">Tự động hóa</h1><p className="mt-3">RSS chưa được cấu hình cho không gian này.</p></div>;

  const client = await createClient();
  const [windowResult, projectResult, destinationResult, scoringResult] = await Promise.all([
    client.rpc("read_sports_auto_publish_control", {
      p_workspace_id: target.workspaceId, p_project_id: target.projectId, p_destination_id: target.destinationId,
    }),
    client.from("content_projects").select("name").eq("workspace_id", workspace.id).eq("id", target.projectId).maybeSingle(),
    client.from("publishing_destinations").select("name,target_ref").eq("workspace_id", workspace.id).eq("id", target.destinationId).maybeSingle(),
    client.from("sports_news_scoring_configs").select("version,threshold,reach_weight,importance_weight,freshness_weight,fallback_mode")
      .eq("workspace_id", workspace.id).eq("project_id", target.projectId).maybeSingle(),
  ]);
  if (windowResult.error || projectResult.error || destinationResult.error || scoringResult.error) throw new Error("automation_control_read_failed");
  const active = windowResult.data?.[0] ?? null;
  const scoring = scoringResult.data;
  const canManage = workspace.role === "owner" || workspace.role === "admin";

  return (
    <div className="football-page space-y-6">
      <div className="football-page-header"><div><p className="football-eyebrow">Football News Control Center</p><h1>Tự động hóa</h1><p>Điều khiển xuất bản RSS lên Telegram của {workspace.name}.</p></div></div>
      {query.status ? <p role="status" className="football-feedback">{query.status === "enabled" ? "Auto Publish đã bật." : query.status === "scoring" ? "Đã lưu barem. Áp dụng từ lượt quét tiếp theo." : "Đã dừng Auto Publish. Bài mới sẽ chờ duyệt."}</p> : null}
      {query.error ? <p role="alert" className="football-feedback is-error">Không lưu được cấu hình. Kiểm tra quyền và giới hạn rồi thử lại.</p> : null}
      <section className="football-panel p-6" aria-label="Trạng thái Auto Publish">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><p className="football-eyebrow">Trạng thái</p><h2 className="text-xl font-bold">{active ? "Auto Publish đang bật" : "Duyệt từng bài"}</h2><p className="mt-2 text-sm text-slate-600">{projectResult.data?.name ?? "Dự án RSS"} · {destinationResult.data?.name ?? "Telegram"}</p></div>
          <span className={`football-state ${active ? "is-on" : ""}`}><Power size={15} aria-hidden="true" />{active ? "Đang tự đăng" : "Đang chờ duyệt"}</span>
        </div>
        {active ? <div className="football-control-details"><p><Clock3 size={16} aria-hidden="true" /> Hết hạn <time dateTime={active.ends_at}>{new Date(active.ends_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" })}</time></p><p>Tối đa {active.max_per_slot} bài mỗi 2 giờ · {active.max_per_window} bài trong cửa sổ</p></div> : null}
      </section>
      {canManage ? <section className="football-panel p-6" aria-label="Thiết lập tự đăng">
        <h2 className="text-lg font-bold">{active ? "Cập nhật cửa sổ tự đăng" : "Bật Auto Publish"}</h2>
        <p className="mt-2 text-sm text-slate-600">Thời hạn tối đa 8 giờ. Khi hết hạn, hệ thống quay về duyệt từng bài.</p>
        <form action={enableAutomation} className="football-control-form">
          <input type="hidden" name="workspaceId" value={workspace.id} />
          <label>Thời hạn (giờ)<input name="hours" type="number" min="1" max="8" step="1" defaultValue="8" required /></label>
          <label>Giới hạn mỗi 2 giờ<input name="perSlot" type="number" min="1" max="10" step="1" defaultValue={active?.max_per_slot ?? 10} required /></label>
          <label>Giới hạn trong cửa sổ<input name="perWindow" type="number" min="1" max="40" step="1" defaultValue={active?.max_per_window ?? 40} required /></label>
          <button type="submit" className="football-action">{active ? "Lưu và bắt đầu cửa sổ mới" : "Bật Auto Publish"}</button>
        </form>
      </section> : null}
      {canManage && active ? <section className="football-panel p-6" aria-label="Dừng khẩn cấp"><h2 className="flex items-center gap-2 text-lg font-bold"><AlertTriangle size={18} aria-hidden="true" /> Emergency Stop</h2><p className="mt-2 text-sm text-slate-600">Dừng nhận lượt tự đăng mới ngay và chuyển về duyệt từng bài.</p><form action={emergencyStop} className="mt-4"><input type="hidden" name="workspaceId" value={workspace.id} /><button type="submit" className="football-stop">Dừng Auto Publish</button></form></section> : null}
      <section className="football-panel p-6" aria-label="Cấu hình chấm điểm">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-bold">Barem độ hot</h2><p className="mt-1 text-sm text-slate-600">Áp dụng từ lượt quét tiếp theo. Bài cũ giữ điểm và cấu hình lúc được chấm.</p></div><span className="text-xs text-slate-500">Phiên bản {scoring?.version ?? 0}</span></div>
        {canManage ? <>
          <form action={saveScoring} className="football-control-form">
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <label>Ngưỡng đạt (0–10)<input name="threshold" type="number" min="0" max="10" step="0.1" defaultValue={scoring?.threshold ?? 8} required /></label>
            <label>Độ nhận diện (%)<input name="reach" type="number" min="0" max="100" step="1" defaultValue={scoring?.reach_weight ?? 45} required /></label>
            <label>Tầm quan trọng (%)<input name="importance" type="number" min="0" max="100" step="1" defaultValue={scoring?.importance_weight ?? 40} required /></label>
            <label>Độ mới (%)<input name="freshness" type="number" min="0" max="100" step="1" defaultValue={scoring?.freshness_weight ?? 15} required /></label>
            <label>Khi không có tin đạt ngưỡng<select name="fallback" defaultValue={scoring?.fallback_mode ?? "highest"}><option value="highest">Lấy tin điểm cao nhất</option><option value="strict">Không chọn tin</option></select></label>
            <button type="submit" className="football-action">Lưu barem</button>
          </form>
          <form action={resetScoring} className="mt-4"><input type="hidden" name="workspaceId" value={workspace.id} /><button type="submit" className="football-reset">Đặt lại 8 điểm · 45/40/15</button></form>
        </> : <p className="mt-4 text-sm text-slate-600">Ngưỡng {scoring?.threshold ?? 8}/10 · Trọng số {scoring?.reach_weight ?? 45}/{scoring?.importance_weight ?? 40}/{scoring?.freshness_weight ?? 15} · {scoring?.fallback_mode === "strict" ? "Chỉ lấy tin đạt ngưỡng" : "Lấy tin điểm cao nhất nếu chưa đạt ngưỡng"}</p>}
      </section>
    </div>
  );
}
