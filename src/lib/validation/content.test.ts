import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CONTENT_LIMITS,
  codePointLength,
  expectedVersionSchema,
  postCreateSchema,
  postInputSchema,
  postUpdateSchema,
  postVersionRefSchema,
  projectCreateSchema,
  projectInputSchema,
  scheduledForSchema,
  uuidSchema,
} from "./content";

const ID = "3f2b8c1e-9a4d-4e2b-8f61-0c7d5a9e1b23";
const ID2 = "7c1d2e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f";

const validPost = { title: "Hello", body: "First draft", status: "draft", scheduledFor: "" };

describe("limits stay in sync with the database migration", () => {
  const sql = readFileSync(
    new URL("../../../supabase/migrations/20261120120000_content_management.sql", import.meta.url),
    "utf8",
  );

  it.each([
    ["project name", `char_length(btrim(name)) between 1 and ${CONTENT_LIMITS.projectNameMax}`],
    ["project description", `char_length(description) <= ${CONTENT_LIMITS.projectDescriptionMax}`],
    ["post title", `char_length(btrim(title)) between 1 and ${CONTENT_LIMITS.postTitleMax}`],
    ["post body", `char_length(body) <= ${CONTENT_LIMITS.postBodyMax}`],
  ])("%s", (_label, constraint) => {
    expect(sql).toContain(constraint);
  });

  it("post status enum still contains the editable statuses", () => {
    expect(sql).toContain("create type public.content_post_status as enum ('draft', 'ready', 'published')");
  });
});

describe("codePointLength", () => {
  it("counts code points like Postgres char_length", () => {
    expect(codePointLength("abc")).toBe(3);
    expect(codePointLength("Tiếng Việt")).toBe(10);
    expect(codePointLength("😀😀")).toBe(2); // 4 UTF-16 units
  });
});

describe("uuidSchema", () => {
  it("accepts a UUID and lower-cases it", () => {
    expect(uuidSchema.parse(` ${ID.toUpperCase()} `)).toBe(ID);
  });

  it.each(["", "not-a-uuid", "3f2b8c1e9a4d4e2b8f610c7d5a9e1b23", `${ID}x`, "1; drop table x"])(
    "rejects %j",
    (value) => {
      expect(uuidSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects non-strings", () => {
    expect(uuidSchema.safeParse(123).success).toBe(false);
    expect(uuidSchema.safeParse(null).success).toBe(false);
  });
});

describe("expectedVersionSchema", () => {
  it.each([
    [1, 1],
    ["1", 1],
    [" 42 ", 42],
    [CONTENT_LIMITS.versionMax, CONTENT_LIMITS.versionMax],
  ])("accepts %j", (input, expected) => {
    expect(expectedVersionSchema.parse(input)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, CONTENT_LIMITS.versionMax + 1, "", "0", "01", "1.5", "1e3", "+1", "abc", null, undefined])(
    "rejects %j",
    (input) => {
      expect(expectedVersionSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe("scheduledForSchema", () => {
  it.each([undefined, null, "", "   "])("treats %j as not scheduled", (input) => {
    expect(scheduledForSchema.parse(input)).toBeNull();
  });

  it("normalises a date-time with offset to UTC", () => {
    expect(scheduledForSchema.parse("2026-12-01T09:00:00+07:00")).toBe("2026-12-01T02:00:00.000Z");
    expect(scheduledForSchema.parse("2026-12-01T09:00:00.000Z")).toBe("2026-12-01T09:00:00.000Z");
  });

  it.each([
    "2026-12-01T09:00", // no offset: ambiguous time zone
    "2026-12-01T09:00:00", // no offset
    "2026-12-01T09:00Z", // seconds are required
    "2026-12-01",
    "2026-02-30T09:00:00Z", // no such day
    "2026-13-01T09:00:00Z",
    "tomorrow",
    "1733043600000",
  ])("rejects %j", (input) => {
    expect(scheduledForSchema.safeParse(input).success).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(scheduledForSchema.safeParse(1733043600000).success).toBe(false);
  });

  it("may be omitted from a post", () => {
    expect(postInputSchema.parse({ title: "Hello", body: "", status: "draft" }).scheduledFor).toBeNull();
  });
});

describe("projectInputSchema", () => {
  it("trims the name and turns an empty description into null", () => {
    expect(projectInputSchema.parse({ name: "  Blog  ", description: "   " })).toEqual({
      name: "Blog",
      description: null,
    });
    expect(projectInputSchema.parse({ name: "Blog" })).toEqual({ name: "Blog", description: null });
  });

  it("accepts names and descriptions at the limits", () => {
    const result = projectInputSchema.safeParse({
      name: "n".repeat(CONTENT_LIMITS.projectNameMax),
      description: "d".repeat(CONTENT_LIMITS.projectDescriptionMax),
    });
    expect(result.success).toBe(true);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(projectInputSchema.safeParse({ name: "😀".repeat(CONTENT_LIMITS.projectNameMax) }).success).toBe(true);
  });

  it.each([
    [{ name: "" }, "required"],
    [{ name: "   " }, "required"],
    [{ name: "n".repeat(CONTENT_LIMITS.projectNameMax + 1) }, "at most 100"],
    [{ name: "Blog", description: "d".repeat(CONTENT_LIMITS.projectDescriptionMax + 1) }, "at most 1,000"],
    [{ name: "Bad\u0000name" }, "invalid character"],
    [{}, ""],
  ])("rejects %j", (input, message) => {
    const result = projectInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success && message) expect(result.error.issues[0]?.message).toContain(message);
  });

  it("strips fields the client must not set", () => {
    const parsed = projectCreateSchema.parse({
      name: "Blog",
      workspaceId: ID,
      created_by: ID2,
      archived_at: "2026-01-01T00:00:00Z",
    });
    expect(parsed).toEqual({ name: "Blog", description: null, workspaceId: ID });
  });

  it("requires a valid workspace id to create", () => {
    expect(projectCreateSchema.safeParse({ name: "Blog", workspaceId: "nope" }).success).toBe(false);
  });
});

describe("postInputSchema", () => {
  it("accepts a valid post and keeps the body as written", () => {
    expect(
      postInputSchema.parse({ ...validPost, title: "  Hello  ", body: "  keep\n  indentation  " }),
    ).toEqual({ title: "Hello", body: "  keep\n  indentation  ", status: "draft", scheduledFor: null });
  });

  it("accepts an empty body, the ready status and a schedule", () => {
    const parsed = postInputSchema.parse({
      ...validPost,
      body: "",
      status: "ready",
      scheduledFor: "2026-12-01T09:00:00Z",
    });
    expect(parsed.status).toBe("ready");
    expect(parsed.scheduledFor).toBe("2026-12-01T09:00:00.000Z");
  });

  it("accepts title and body at the limits", () => {
    const result = postInputSchema.safeParse({
      ...validPost,
      title: "t".repeat(CONTENT_LIMITS.postTitleMax),
      body: "b".repeat(CONTENT_LIMITS.postBodyMax),
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["published status", { ...validPost, status: "published" }],
    ["unknown status", { ...validPost, status: "archived" }],
    ["missing status", { title: "Hello", body: "", scheduledFor: "" }],
    ["blank title", { ...validPost, title: "   " }],
    ["over-long title", { ...validPost, title: "t".repeat(CONTENT_LIMITS.postTitleMax + 1) }],
    ["over-long body", { ...validPost, body: "b".repeat(CONTENT_LIMITS.postBodyMax + 1) }],
    ["missing body", { title: "Hello", status: "draft", scheduledFor: "" }],
    ["NUL in body", { ...validPost, body: "a\u0000b" }],
    ["schedule without offset", { ...validPost, scheduledFor: "2026-12-01T09:00" }],
  ])("rejects %s", (_label, input) => {
    expect(postInputSchema.safeParse(input).success).toBe(false);
  });

  it("strips server-managed fields", () => {
    const parsed = postInputSchema.parse({
      ...validPost,
      version: 99,
      created_by: ID2,
      published_at: "2026-01-01T00:00:00Z",
      archived_at: "2026-01-01T00:00:00Z",
    });
    expect(Object.keys(parsed).sort()).toEqual(["body", "scheduledFor", "status", "title"]);
  });
});

describe("post create / update / archive schemas", () => {
  it("create requires workspace and project ids", () => {
    expect(postCreateSchema.safeParse({ ...validPost, workspaceId: ID, projectId: ID2 }).success).toBe(true);
    expect(postCreateSchema.safeParse({ ...validPost, workspaceId: ID }).success).toBe(false);
    expect(postCreateSchema.safeParse({ ...validPost, workspaceId: ID, projectId: "x" }).success).toBe(false);
  });

  it("update requires the post id and expected version", () => {
    expect(postUpdateSchema.parse({ ...validPost, postId: ID, expectedVersion: "3" }).expectedVersion).toBe(3);
    expect(postUpdateSchema.safeParse({ ...validPost, postId: ID }).success).toBe(false);
    expect(postUpdateSchema.safeParse({ ...validPost, postId: ID, expectedVersion: "0" }).success).toBe(false);
    expect(postUpdateSchema.safeParse({ ...validPost, expectedVersion: 1 }).success).toBe(false);
  });

  it("archive / restore require the post id and expected version", () => {
    expect(postVersionRefSchema.parse({ postId: ID, expectedVersion: 2 })).toEqual({
      postId: ID,
      expectedVersion: 2,
    });
    expect(postVersionRefSchema.safeParse({ postId: ID }).success).toBe(false);
    expect(postVersionRefSchema.safeParse({ postId: "x", expectedVersion: 2 }).success).toBe(false);
  });
});
