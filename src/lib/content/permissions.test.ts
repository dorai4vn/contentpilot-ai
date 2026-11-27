import { describe, expect, it } from "vitest";

import { contentPermissions } from "./permissions";

describe("contentPermissions", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["member", false],
  ] as const)("%s manages projects: %s", (role, manage) => {
    expect(contentPermissions(role)).toEqual({ manageProjects: manage, manageWorkspace: manage, editPosts: true });
  });
});
