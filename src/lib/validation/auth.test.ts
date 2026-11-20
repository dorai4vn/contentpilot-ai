import { describe, expect, it } from "vitest";

import { fieldErrorsFrom, parseCredentials, workspaceNameSchema } from "./auth";

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe("parseCredentials", () => {
  it("normalises the email", () => {
    const result = parseCredentials(form({ email: "  Alice@Example.COM ", password: "correct horse" }));
    expect(result.success && result.data.email).toBe("alice@example.com");
  });

  it("reports field errors", () => {
    const result = parseCredentials(form({ email: "nope", password: "short" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = fieldErrorsFrom(result.error);
      expect(errors.email).toBeDefined();
      expect(errors.password).toMatch(/8 ký tự/);
    }
  });

  it("handles missing fields", () => {
    expect(parseCredentials(new FormData()).success).toBe(false);
  });
});

describe("workspaceNameSchema", () => {
  it("trims and accepts a valid name", () => {
    expect(workspaceNameSchema.parse("  Marketing  ")).toBe("Marketing");
  });

  it.each(["", "   ", "x".repeat(101)])("rejects %j", (name) => {
    expect(workspaceNameSchema.safeParse(name).success).toBe(false);
  });
});
