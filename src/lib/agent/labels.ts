/**
 * Vietnamese labels for the AI assistant UI. Pure data: safe for browser code
 * (no server-only imports). Used for live chat actions and for the persisted
 * agent_actions log, which stores codes only.
 */

export const TOOL_LABELS: Record<string, string> = {
  list_projects: "Đọc danh sách dự án",
  list_posts: "Đọc danh sách bài viết",
  get_post: "Đọc nội dung bài viết",
  create_post: "Tạo bài viết",
  update_post: "Cập nhật bài viết",
  list_publish_destinations: "Xem các đích xuất bản",
  request_publish: "Gửi yêu cầu xuất bản",
  unknown: "Công cụ không hợp lệ",
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? TOOL_LABELS.unknown!;
}

/** Short reason for a failed or skipped action, from its code. */
export const ACTION_CODE_LABELS: Record<string, string> = {
  not_found: "Không tìm thấy hoặc không có quyền truy cập.",
  forbidden: "Không có quyền thực hiện.",
  archived: "Bài viết hoặc dự án đang được lưu trữ.",
  not_draft: "Chỉ được sửa bài ở trạng thái Bản nháp.",
  version_conflict: "Bài viết vừa được người khác thay đổi; không ghi đè.",
  invalid_input: "Dữ liệu không hợp lệ.",
  unknown_tool: "Công cụ không được phép.",
  read_required: "Cần đọc bài viết trước khi sửa hoặc gửi yêu cầu xuất bản.",
  request_pending_exists: "Bài viết đã có yêu cầu xuất bản đang chờ duyệt cho đích này.",
  post_published: "Bài viết đã được xuất bản.",
  destination_disabled: "Đích xuất bản đang tạm ngừng.",
  stale_version: "Phiên bản không khớp với bản vừa đọc.",
  conflict_no_retry: "Không thử lại sau xung đột phiên bản.",
  tool_limit: "Đã đạt giới hạn số lần gọi công cụ.",
  write_limit: "Đã đạt giới hạn số thao tác ghi.",
  unauthenticated: "Phiên đăng nhập đã hết hạn.",
  unknown: "Lỗi không xác định.",
};

export function actionCodeLabel(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return ACTION_CODE_LABELS[code] ?? ACTION_CODE_LABELS.unknown;
}

/** Why the assistant stopped, when it did not finish normally. */
export const STOP_REASON_LABELS: Record<string, string> = {
  tool_limit: "Trợ lý dừng vì đạt giới hạn 6 lần gọi công cụ trong một lượt.",
  write_limit: "Trợ lý dừng vì đạt giới hạn 3 thao tác ghi trong một lượt.",
  turn_limit: "Trợ lý dừng vì yêu cầu cần quá nhiều bước.",
  timeout: "Trợ lý dừng vì xử lý quá lâu.",
  model_error: "Trợ lý dừng vì dịch vụ AI gặp lỗi.",
};

export const FIELD_LABELS: Record<string, string> = {
  title: "tiêu đề",
  body: "nội dung",
  scheduled_for: "lịch đăng",
};
