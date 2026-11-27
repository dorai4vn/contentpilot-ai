import type { recentEventDecisions } from "../_lib/football-news";

type Decisions = Awaited<ReturnType<typeof recentEventDecisions>>;

const REASON_LABELS: Record<string, string> = {
  same_event_key: "Cùng sự kiện",
  same_event_cluster: "Cùng cụm sự kiện (kiểm tra lại ở DB)",
  same_team_pair: "Cùng cặp đội",
  same_person: "Cùng cầu thủ/HLV",
  same_person_alias: "Cùng người (khớp họ + cùng CLB)",
  same_match_report: "Bản tin lại về cùng trận",
  stale_preview_after_result: "Nhận định đăng sau khi có kết quả",
  no_new_information: "Không có thông tin mới",
  same_run_weaker_report: "Bản yếu hơn trong cùng lượt quét",
  score_changed: "Tỷ số thay đổi",
  event_type_changed: "Từ nhận định sang kết quả",
  status_upgraded: "Tin đồn → chính thức",
};

/** Structured evidence of semantic skips and follow-ups, shown next to the news feed (read-only). */
export function SemanticEventLog({ items }: { items: Decisions }) {
  if (!items.length) return <div className="football-empty">Chưa có tin nào bị bỏ qua hoặc được nối tiếp theo sự kiện.</div>;
  return (
    <ul className="football-news-list">
      {items.map((item) => (
        <li key={`${item.source_url}-${item.decision}`} className="football-news-row">
          <div className="football-news-main">
            <div className="football-news-meta">
              <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" })}</time>
              <span aria-hidden="true">·</span>
              <strong>{item.decision === "follow_up" ? "Tin nối tiếp" : "Bỏ qua (trùng sự kiện)"}</strong>
            </div>
            <h2>{item.matchedTitle ?? item.matchedSourceUrl ?? item.source_url}</h2>
            <p className="football-news-meta">
              {item.reasons.map((reason) => REASON_LABELS[reason.code] ?? reason.code).join(" · ")}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
