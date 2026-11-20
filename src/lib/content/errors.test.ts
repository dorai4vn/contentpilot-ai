import { describe, expect, it } from "vitest";

import { postInputSchema } from "@/lib/validation/content";

import {
  CONTENT_ERROR_MESSAGES,
  ContentError,
  contentFieldErrors,
  parseContentInput,
  toContentError,
} from "./errors";

describe("toContentError", () => {
  it.each([
    ["CP404", "not_found"],
    ["CP409", "version_conflict"],
    ["CP423", "archived"],
    ["42501", "forbidden"],
    ["23514", "invalid_input"],
    ["23502", "invalid_input"],
    ["22023", "invalid_input"],
    ["22P02", "invalid_input"],
    ["23503", "not_found"],
    ["PGRST116", "not_found"],
  ])("maps %s to %s", (sqlstate, code) => {
    const error = toContentError({ code: sqlstate, message: "x" });
    expect(error).toBeInstanceOf(ContentError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(CONTENT_ERROR_MESSAGES[code as keyof typeof CONTENT_ERROR_MESSAGES]);
  });

  it.each([
    [{ code: "XX000", message: "boom" }],
    [{ code: 42501 }],
    [{ message: "no code" }],
    [new Error("network down")],
    ["string error"],
    [null],
    [undefined],
  ])("maps anything else to unknown: %j", (input) => {
    expect(toContentError(input).code).toBe("unknown");
  });

  it("never copies database message, details or hint", () => {
    const error = toContentError({
      code: "23514",
      message: 'new row for relation "content_posts" violates check constraint "content_posts_title_check"',
      details: "Failing row contains (secret)",
      hint: "internal hint",
    });
    const serialised = JSON.stringify({ ...error, message: error.message });
    expect(serialised).not.toMatch(/content_posts|constraint|secret|internal hint/);
    expect(error.fieldErrors).toBeUndefined();
  });

  it("returns ContentError instances unchanged", () => {
    const original = new ContentError("archived");
    expect(toContentError(original)).toBe(original);
  });

  it("explains a version conflict without technical words", () => {
    expect(toContentError({ code: "CP409" }).message).toMatch(/người khác cập nhật/i);
  });
});

describe("parseContentInput", () => {
  it("returns parsed data", () => {
    expect(parseContentInput(postInputSchema, { title: " Hi ", body: "", status: "draft" })).toEqual({
      title: "Hi",
      body: "",
      status: "draft",
      scheduledFor: null,
    });
  });

  it("throws invalid_input with per-field messages", () => {
    try {
      parseContentInput(postInputSchema, { title: "", body: "", status: "published" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContentError);
      const contentError = error as ContentError;
      expect(contentError.code).toBe("invalid_input");
      expect(contentError.fieldErrors?.title).toMatch(/Vui lòng nhập/);
      expect(contentError.fieldErrors?.status).toMatch(/Bản nháp hoặc Sẵn sàng/);
    }
  });

  it("names every forbidden field that was sent", () => {
    const result = postInputSchema.safeParse({
      title: "Hi",
      body: "",
      status: "draft",
      version: 9,
      published_at: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(contentFieldErrors(result.error)).toEqual({
        version: "Không được phép gửi trường này.",
        published_at: "Không được phép gửi trường này.",
      });
    }
  });
});
