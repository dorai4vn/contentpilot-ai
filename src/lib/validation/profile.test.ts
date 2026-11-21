import { describe, expect, it } from "vitest";

import { displayNameSchema, optionalDisplayNameSchema, profileUpdateSchema } from "./profile";

describe("displayNameSchema", () => {
  it.each([
    ["  Nguyễn  Thị   Ánh ", "Nguyễn Thị Ánh"],
    ["An", "An"],
    ["ă".repeat(60), "ă".repeat(60)],
    ["😀".repeat(60), "😀".repeat(60)],
  ])("accepts %j as %j", (input, output) => {
    expect(displayNameSchema.parse(input)).toBe(output);
  });

  it.each([
    ["", "Vui lòng nhập tên hiển thị."],
    ["   ", "Vui lòng nhập tên hiển thị."],
    ["a".repeat(61), "Tên hiển thị tối đa 60 ký tự."],
    ["An\nBình", "Tên hiển thị chứa ký tự không hợp lệ."],
    ["An\tBình", "Tên hiển thị chứa ký tự không hợp lệ."],
    ["An\u0000", "Tên hiển thị chứa ký tự không hợp lệ."],
    ["An\u0085", "Tên hiển thị chứa ký tự không hợp lệ."],
  ])("rejects %j", (input, message) => {
    const result = displayNameSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });
});

describe("profileUpdateSchema", () => {
  it.each(["userId", "user_id", "role", "email", "createdAt"])("rejects the extra field %s", (key) => {
    expect(profileUpdateSchema.safeParse({ displayName: "An", [key]: "x" }).success).toBe(false);
  });
});

describe("optionalDisplayNameSchema (sign-up)", () => {
  it.each([undefined, null, "", "   "])("treats %j as no name", (input) => {
    expect(optionalDisplayNameSchema.parse(input)).toBeNull();
  });
  it("validates a given name", () => {
    expect(optionalDisplayNameSchema.parse(" An ")).toBe("An");
    expect(optionalDisplayNameSchema.safeParse("x".repeat(61)).success).toBe(false);
  });
});
