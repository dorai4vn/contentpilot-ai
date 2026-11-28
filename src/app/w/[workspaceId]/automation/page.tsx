import { AlertTriangle, Clock3, Power } from "lucide-react";
import type { Metadata } from "next";

import { sportsControlTarget } from "@/lib/sports-news/control-target";
import { createClient } from "@/lib/supabase/server";

import { loadWorkspace } from "../../_lib/load";
import { emergencyStop, resetScoring, saveScoring, setAutomationMode } from "./actions";

export const metadata: Metadata = { title: "Auto Post" };

export default async function AutomationPage({ params, searchParams }: PageProps<"/w/[workspaceId]/automation">) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/automation`);
  const target = sportsControlTarget(workspace.id);
  if (!target) return <div className="football-page"><h1 className="text-2xl font-bold">Auto Post</h1><p className="mt-3">RSS chưa được cấu hình cho không gian này.</p></div>;

  const client = await createClient();
  const [windowResult, projectResult, destinationResult, scoringResult, modeResult, eventsResult] = await Promise.all([
    client.rpc("read_sports_auto_publish_control", {
      p_workspace_id: target.workspaceId, p_project_id: target.projectId, p_destination_id: target.destinationId,
    }),
    client.from("content_projects").select("name").eq("workspace_id", workspace.id).eq("id", target.projectId).maybeSingle(),
    client.from("publishing_destinations").select("name,target_ref").eq("workspace_id", workspace.id).eq("id", target.destinationId).maybeSingle(),
    client.from("sports_news_scoring_configs").select("version,threshold,reach_weight,importance_weight,freshness_weight,engagement_weight,fallback_mode")
      .eq("workspace_id", workspace.id).eq("project_id", target.projectId).maybeSingle(),
    client.rpc("get_sports_automation_mode", { p_workspace_id: workspace.id, p_project_id: target.projectId }),
    client.rpc("list_sports_automation_events", { p_workspace_id: workspace.id, p_project_id: target.projectId }),
  ]);
  if (windowResult.error || projectResult.error || destinationResult.error || scoringResult.error || modeResult.error || eventsResult.error) throw new Error("automation_control_read_failed");
  const active = windowResult.data?.[0] ?? null;
  const current = modeResult.data?.[0] ?? { mode: "off", daily_quota: 20, version: 0, updated_at: null, scan_interval_hours: 2, posts_per_scan: 2, last_scan_at: null };
  const mode = current.mode === "semi" || current.mode === "auto" ? current.mode : "off";
  const events = eventsResult.data ?? [];
  const when = (value: string) => new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" });
  const scoring = scoringResult.data;
  const canManage = workspace.role === "owner" || workspace.role === "admin";

  return (
    <div className="football-page space-y-6">
      <div className="football-page-header"><div><p className="football-eyebrow">Social Automation</p><h1>Auto Post</h1><p>Tự động thu thập RSS, viết lại, tìm ảnh và đăng bài lên các kênh social của brand.</p></div></div>
      {query.status ? <p role="status" className="football-feedback">{query.status === "mode-auto" ? "Đã chuyển sang Auto Publish. Chỉ áp dụng cho bài tạo từ bây giờ." : query.status === "mode-semi" ? "Đã chuyển sang Semi Publish. Bài mới chờ duyệt trước khi gửi." : query.status === "mode-off" ? "Đã tắt Auto Post. Không quét RSS, không gọi AI và không gửi bài." : query.status === "scoring" ? "Đã lưu tiêu chuẩn xuất bản. Áp dụng từ lượt quét tiếp theo." : "Đã lưu."}</p> : null}
      {query.error ? <p role="alert" className="football-feedback is-error">Không lưu được cấu hình. Kiểm tra quyền và giới hạn rồi thử lại.</p> : null}
      <section className="football-panel p-6" aria-label="Chế độ Auto Post">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><p className="football-eyebrow">Chế độ hiện tại</p><h2 className="text-xl font-bold">{mode === "auto" ? "Auto Publish" : mode === "semi" ? "Semi Publish" : "Off"}</h2><p className="mt-2 text-sm text-slate-600">ContentPilot AI · Tự động đăng tin mỗi ngày trên các kênh social brand</p></div>
          <span className={`football-state ${mode === "auto" ? "is-on" : ""}`}><Power size={15} aria-hidden="true" />{mode === "auto" ? "Đang tự đăng" : mode === "semi" ? "Chờ duyệt trước khi gửi" : "Đã tắt"}</span>
        </div>
        <div className="football-control-details">
          {mode === "auto" && active ? <p><Clock3 size={16} aria-hidden="true" /> Liên tục từ <time dateTime={active.starts_at}>{when(active.starts_at)}</time>, đến khi đổi chế độ</p> : null}
          <p>Tối đa {current.posts_per_scan} bài mỗi lượt quét (mỗi {current.scan_interval_hours} giờ, gộp mọi nguồn RSS) · tối đa {current.daily_quota} bài mỗi ngày (giới hạn cứng, không phải mục tiêu)</p>
        </div>
      </section>
      {canManage ? <section className="football-panel p-6" aria-label="Phương thức xuất bản">
        <h2 className="text-lg font-bold">Phương thức xuất bản</h2>
        <p className="mt-2 text-sm text-slate-600">Đổi chế độ không tự gửi lại bài cũ. Auto chỉ áp dụng cho bài tạo sau thời điểm bật.</p>
        <form action={setAutomationMode} className="football-mode-form" data-testid="mode-form">
          <input type="hidden" name="workspaceId" value={workspace.id} />
          <fieldset className="football-mode-options">
            <legend className="sr-only">Phương thức xuất bản</legend>
            <label><input type="radio" name="mode" value="auto" defaultChecked={mode === "auto"} required /><span><strong>Auto Publish</strong>Tự quét RSS, chấm điểm, loại trùng, viết caption, xử lý ảnh và gửi liên tục cho đến khi đổi chế độ. Trùng đã xác nhận vẫn bị chặn.</span></label>
            <label><input type="radio" name="mode" value="semi" defaultChecked={mode === "semi"} /><span><strong>Semi Publish</strong>Tự quét, chấm điểm, loại trùng, viết caption và xử lý ảnh; người duyệt phải phê duyệt trước khi gửi.</span></label>
            <label><input type="radio" name="mode" value="off" defaultChecked={mode === "off"} /><span><strong>Off</strong>Dừng quét RSS, gọi AI, xử lý ảnh và gửi bài trước mọi cuộc gọi ngoài. Việc đang chạy dừng ở điểm kiểm tra an toàn.</span></label>
          </fieldset>
          <label className="football-quota">Daily Limit — bài mỗi ngày (1–120)<input name="dailyQuota" type="number" min="1" max="120" step="1" defaultValue={current.daily_quota} required /></label>
          <label className="football-quota">Scan Interval — giờ giữa hai lượt quét (2–24, bước 2)<input name="scanIntervalHours" type="number" min="2" max="24" step="2" defaultValue={current.scan_interval_hours} required /></label>
          <label className="football-quota">Posts per Scan — bài mỗi lượt, tổng mọi nguồn (1–10)<input name="postsPerScan" type="number" min="1" max="10" step="1" defaultValue={current.posts_per_scan} required /></label>
          <button type="submit" className="football-action">Lưu</button>
        </form>
      </section> : null}
      {canManage && mode === "auto" ? <section className="football-panel p-6" aria-label="Dừng khẩn cấp"><h2 className="flex items-center gap-2 text-lg font-bold"><AlertTriangle size={18} aria-hidden="true" /> Emergency Stop</h2><p className="mt-2 text-sm text-slate-600">Dừng tự đăng ngay và chuyển về Off: không quét RSS, không gọi AI, không gửi bài.</p><form action={emergencyStop} className="mt-4"><input type="hidden" name="workspaceId" value={workspace.id} /><input type="hidden" name="dailyQuota" value={current.daily_quota} /><input type="hidden" name="scanIntervalHours" value={current.scan_interval_hours} /><input type="hidden" name="postsPerScan" value={current.posts_per_scan} /><button type="submit" className="football-stop">Dừng khẩn cấp (Off)</button></form></section> : null}
      <section className="football-panel p-6" aria-label="Nhật ký chế độ">
        <h2 className="text-lg font-bold">Lịch sử thao tác</h2>
        {events.length ? <ul className="football-mode-log">{events.map((event) => <li key={event.created_at}><time dateTime={event.created_at}>{when(event.created_at)}</time><span>{event.from_mode.toUpperCase()} → {event.to_mode.toUpperCase()} · {event.daily_quota}/ngày{event.scan_interval_hours ? ` · ${event.scan_interval_hours}h · ${event.posts_per_scan} bài/lượt` : ""}</span></li>)}</ul> : <p className="mt-2 text-sm text-slate-600">Chưa có thay đổi chế độ nào.</p>}
      </section>
      <section className="football-panel p-6" aria-label="Cấu hình chấm điểm">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-bold">Tiêu chuẩn xuất bản</h2><p className="mt-1 text-sm text-slate-600">Áp dụng từ lượt quét tiếp theo. Bài cũ giữ điểm và cấu hình lúc được chấm.</p></div><span className="text-xs text-slate-500">Phiên bản {scoring?.version ?? 0}</span></div>
        {canManage ? <>
          <form action={saveScoring} className="football-control-form" data-testid="scoring-form">
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <label>Threshold (0–10)<input name="threshold" type="number" min="0" max="10" step="0.1" defaultValue={scoring?.threshold ?? 8} required /></label>
            <label>Popularity (%)<input name="reach" type="number" min="0" max="100" step="1" defaultValue={scoring?.reach_weight ?? 30} required /></label>
            <label>Importance (%)<input name="importance" type="number" min="0" max="100" step="1" defaultValue={scoring?.importance_weight ?? 25} required /></label>
            <label>Recency (%)<input name="freshness" type="number" min="0" max="100" step="1" defaultValue={scoring?.freshness_weight ?? 25} required /></label>
            <label>Engagement (%)<input name="engagement" type="number" min="0" max="100" step="1" defaultValue={scoring?.engagement_weight ?? 20} required /></label>
            <label>Fallback mode<select name="fallback" defaultValue={scoring?.fallback_mode ?? "highest"}><option value="highest">Lấy tin điểm cao nhất</option><option value="strict">Không chọn tin</option></select></label>
            <button type="submit" className="football-action">Lưu</button>
          </form>
          <form action={resetScoring} className="mt-4"><input type="hidden" name="workspaceId" value={workspace.id} /><button type="submit" className="football-reset">Đặt lại 8 điểm · 30/25/25/20</button></form>
        </> : <p className="mt-4 text-sm text-slate-600">Ngưỡng {scoring?.threshold ?? 8}/10 · Trọng số {scoring?.reach_weight ?? 30}/{scoring?.importance_weight ?? 25}/{scoring?.freshness_weight ?? 25}/{scoring?.engagement_weight ?? 20} · {scoring?.fallback_mode === "strict" ? "Chỉ lấy tin đạt ngưỡng" : "Lấy tin điểm cao nhất nếu chưa đạt ngưỡng"}</p>}
      </section>
    </div>
  );
}
