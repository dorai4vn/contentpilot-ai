import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadWorkspace: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/app/w/_lib/load", () => ({ loadWorkspace: mocks.loadWorkspace }));
vi.mock("@/lib/sports-news/control-target", () => ({ sportsControlTarget: () => ({
  workspaceId: "workspace-1", projectId: "project-1", destinationId: "destination-1",
}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/app/w/[workspaceId]/automation/actions", () => ({
  setAutomationMode: vi.fn(), emergencyStop: vi.fn(), saveScoring: vi.fn(), resetScoring: vi.fn(),
}));

import AutomationPage from "./[workspaceId]/automation/page";

const rpcFor = (mode: string) => async (name: string) => {
  if (name === "get_sports_automation_mode") return { data: [{ mode, daily_quota: 25, version: 2, updated_at: "2026-11-28T08:00:00Z" }], error: null };
  if (name === "list_sports_automation_events") return { data: [{ from_mode: "semi", to_mode: mode, daily_quota: 25, created_at: "2026-11-28T08:00:00Z" }], error: null };
  return { data: mode === "auto" ? [{ starts_at: "2026-11-28T08:00:00Z", ends_at: null, persistent: true, max_per_slot: 10, max_per_window: 40, max_per_day: 25 }] : [], error: null };
};

it("shows the real mode, quota and audit log and restricts controls to Owner/Admin", async () => {
  mocks.rpc.mockImplementation(rpcFor("auto"));
  mocks.from.mockImplementation(() => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Tin bóng đá" }, error: null }) }) }) }) }));
  const input = { params: Promise.resolve({ workspaceId: "workspace-1" }), searchParams: Promise.resolve({}) };

  mocks.loadWorkspace.mockResolvedValue({ workspace: { id: "workspace-1", name: "Sports", role: "owner" } });
  const owner = renderToStaticMarkup(await AutomationPage(input as never));
  expect(owner).toContain("25 bài mỗi ngày");
  expect(owner).toContain("Auto Publish");
  expect(owner).toContain("Semi Publish");
  expect(owner).toContain("SEMI → AUTO");
  expect(owner).toContain("Emergency Stop");
  expect(owner).toContain("Dừng khẩn cấp (Off)");
  expect(owner).toContain("Tối đa 3 bài mỗi lượt quét");
  expect(owner).toContain("Auto Post");
  expect(owner).toContain("Phương thức xuất bản");
  expect(owner).toContain("Tiêu chuẩn xuất bản");
  expect(owner).toContain("Lịch sử thao tác");
  expect(owner).toContain("Threshold (0–10)");
  expect(owner).toContain("Fallback mode");
  expect(owner).toMatch(/data-testid="mode-form"[\s\S]*>Lưu<\/button>/);
  expect(owner).toMatch(/data-testid="scoring-form"[\s\S]*>Lưu<\/button>/);

  mocks.loadWorkspace.mockResolvedValue({ workspace: { id: "workspace-1", name: "Sports", role: "member" } });
  const member = renderToStaticMarkup(await AutomationPage(input as never));
  expect(member).not.toContain("Dừng khẩn cấp (Off)");
  expect(member).not.toContain("data-testid=\"mode-form\"");
});

it("keeps an explicit Semi mode (never Auto) and hides Emergency Stop when not in Auto", async () => {
  mocks.rpc.mockImplementation(async (name: string) => name === "get_sports_automation_mode"
    ? { data: [{ mode: "semi", daily_quota: 40, version: 0, updated_at: null }], error: null } : { data: [], error: null });
  mocks.from.mockImplementation(() => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }));
  mocks.loadWorkspace.mockResolvedValue({ workspace: { id: "workspace-1", name: "Sports", role: "admin" } });
  const html = renderToStaticMarkup(await AutomationPage({ params: Promise.resolve({ workspaceId: "workspace-1" }), searchParams: Promise.resolve({}) } as never));
  expect(html).toContain("Chờ duyệt trước khi gửi");
  expect(html).not.toContain("Emergency Stop");
});

it("fails safe to Off when the mode configuration is missing", async () => {
  mocks.rpc.mockImplementation(async () => ({ data: [], error: null }));
  mocks.from.mockImplementation(() => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }));
  mocks.loadWorkspace.mockResolvedValue({ workspace: { id: "workspace-1", name: "Sports", role: "admin" } });
  const html = renderToStaticMarkup(await AutomationPage({ params: Promise.resolve({ workspaceId: "workspace-1" }), searchParams: Promise.resolve({}) } as never));
  expect(html).toContain("Đã tắt");
  expect(html).not.toContain("Emergency Stop");
  expect(html).toContain("30/25/25/20");
});
