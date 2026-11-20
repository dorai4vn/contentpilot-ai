import { describe, expect, it } from "vitest";

import { isAuthPage, isProtectedPath, safeRedirectPath } from "./routes";

describe("isProtectedPath", () => {
  it.each(["/dashboard", "/dashboard/", "/dashboard/settings"])("protects %s", (p) => {
    expect(isProtectedPath(p)).toBe(true);
  });

  it.each(["/", "/login", "/signup", "/api/health", "/dashboards", "/dashboardx/a"])("does not protect %s", (p) => {
    expect(isProtectedPath(p)).toBe(false);
  });
});

describe("isAuthPage", () => {
  it("matches login and signup", () => {
    expect(isAuthPage("/login")).toBe(true);
    expect(isAuthPage("/signup")).toBe(true);
    expect(isAuthPage("/dashboard")).toBe(false);
  });
});

describe("safeRedirectPath", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeRedirectPath("/dashboard")).toBe("/dashboard");
    expect(safeRedirectPath("/dashboard/a?tab=1#x")).toBe("/dashboard/a?tab=1#x");
  });

  it.each([
    undefined,
    null,
    42,
    "",
    "dashboard",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/dashboard",
    "javascript:alert(1)",
    "/dash\nboard",
    "/login",
    `/${"a".repeat(600)}`,
  ])("rejects %j", (value) => {
    expect(safeRedirectPath(value)).toBe("/dashboard");
  });

  it("uses the provided fallback", () => {
    expect(safeRedirectPath("//evil", "/")).toBe("/");
  });
});
