import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockPath = "/w/ws1";
vi.mock("next/navigation", () => ({ usePathname: () => mockPath }));

import { WorkspaceNav } from "./workspace-nav";

function render(path: string, automationAvailable = true) {
  mockPath = path;
  return renderToStaticMarkup(
    <WorkspaceNav workspaceId="ws1" workspaceName="Demo" roleLabel="Owner" pendingCount={2} automationAvailable={automationAvailable} />,
  );
}

describe("WorkspaceNav", () => {
  it("puts Settings in its own footer, outside the Content Studio group", () => {
    const html = render("/w/ws1");
    const footerStart = html.indexOf('data-testid="sidebar-footer"');
    expect(footerStart).toBeGreaterThan(html.indexOf("Content Studio"));
    const settings = html.indexOf('data-testid="nav-settings"');
    expect(settings).toBeGreaterThan(footerStart);
    expect(html.match(/data-testid="nav-settings"/g)).toHaveLength(1);
    expect(html).toContain('href="/w/ws1/settings"');
    // Settings must not sit between the Studio group header and the footer.
    const studioChunk = html.slice(html.indexOf("Content Studio"), footerStart);
    expect(studioChunk).not.toContain("nav-settings");
  });

  it("keeps every other nav item", () => {
    const html = render("/w/ws1");
    for (const id of ["overview", "news", "approvals", "automation", "studio", "agent"]) {
      expect(html).toContain(`data-testid="nav-${id}"`);
    }
    expect(render("/w/ws1", false)).not.toContain('data-testid="nav-automation"');
  });

  it("marks Settings active with aria-current only on the settings route", () => {
    const active = render("/w/ws1/settings");
    expect(active).toMatch(/aria-current="page"[^>]*data-testid="nav-settings"/);
    expect(render("/w/ws1/news")).not.toMatch(/aria-current="page"[^>]*data-testid="nav-settings"/);
  });
});
