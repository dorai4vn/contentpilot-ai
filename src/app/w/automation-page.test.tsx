import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadWorkspace: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/app/w/_lib/load", () => ({ loadWorkspace: mocks.loadWorkspace }));
vi.mock("@/lib/sports-news/control-target", () => ({ sportsControlTarget: () => ({
  workspaceId: "workspace-1", projectId: "project-1", destinationId: "destination-1",
}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/app/w/[workspaceId]/automation/actions", () => ({ enableAutomation: vi.fn(), emergencyStop: vi.fn() }));

import AutomationPage from "./[workspaceId]/automation/page";

it("shows real window limits and restricts controls to Owner/Admin", async () => {
  mocks.rpc.mockResolvedValue({ data: [{ ends_at: "2026-11-27T12:00:00Z", max_per_slot: 3, max_per_window: 12 }], error: null });
  mocks.from.mockImplementation(() => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Tin bóng đá" }, error: null }) }) }) }) }));
  const input = { params: Promise.resolve({ workspaceId: "workspace-1" }), searchParams: Promise.resolve({}) };

  mocks.loadWorkspace.mockResolvedValue({ workspace: { id: "workspace-1", name: "Sports", role: "owner" } });
  const owner = renderToStaticMarkup(await AutomationPage(input as never));
  expect(owner).toContain("3 bài mỗi 2 giờ");
  expect(owner).toContain("Emergency Stop");

  mocks.loadWorkspace.mockResolvedValue({ workspace: { id: "workspace-1", name: "Sports", role: "member" } });
  const member = renderToStaticMarkup(await AutomationPage(input as never));
  expect(member).not.toContain("Dừng Auto Publish");
});
