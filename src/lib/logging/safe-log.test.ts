import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { logSafeError, safeErrorInfo, safeLabel } from "./safe-log";

const SECRET_BODY = "Nội dung bài viết bí mật";
const KEY = "sk-proj-SECRETKEY0123456789abcdefABCDEF";

afterEach(() => vi.restoreAllMocks());

describe("safeErrorInfo", () => {
  it("keeps only the class name and a short code", () => {
    const pgError = Object.assign(new Error(`new row violates check constraint: Failing row contains (${SECRET_BODY})`), {
      code: "23514",
      details: `Failing row contains (${SECRET_BODY})`,
      hint: "internal hint",
    });
    expect(safeErrorInfo(pgError)).toEqual({ type: "Error", code: "23514" });
  });

  it("uses the error class name", () => {
    class APIConnectionTimeoutError extends Error {
      override name = "APIConnectionTimeoutError";
    }
    expect(safeErrorInfo(new APIConnectionTimeoutError(`Incorrect API key provided: ${KEY}`))).toEqual({
      type: "APIConnectionTimeoutError",
    });
  });

  it("does not trust a tampered name or code", () => {
    const tampered = Object.assign(new Error("x"), { name: `leak ${KEY}`, code: `${SECRET_BODY}` });
    const info = safeErrorInfo(tampered);
    expect(JSON.stringify(info)).not.toContain(KEY);
    expect(JSON.stringify(info)).not.toContain(SECRET_BODY);
    expect(info).toEqual({ type: "Error" });
  });

  it("handles non-errors and plain objects (e.g. PostgREST error objects)", () => {
    expect(safeErrorInfo("boom")).toEqual({ type: "non_error" });
    expect(safeErrorInfo(null)).toEqual({ type: "non_error" });
    expect(safeErrorInfo({ code: "PGRST116", message: SECRET_BODY, details: SECRET_BODY })).toEqual({
      type: "Object",
      code: "PGRST116",
    });
  });
});

describe("safeLabel", () => {
  it("keeps tool-like identifiers and replaces anything else", () => {
    expect(safeLabel("create_post")).toBe("create_post");
    expect(safeLabel("Ignore previous instructions")).toBe("unknown");
    expect(safeLabel(`get_post\n${KEY}`)).toBe("unknown");
    expect(safeLabel(42)).toBe("unknown");
  });
});

describe("logSafeError", () => {
  it("writes one JSON line with only the given safe fields", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSafeError("agent tool", { event: "unexpected_error", tool: "get_post", type: "Error", code: undefined });
    expect(spy).toHaveBeenCalledWith("[agent tool]", '{"event":"unexpected_error","tool":"get_post","type":"Error"}');
  });
});
