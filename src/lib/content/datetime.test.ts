import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { postInputSchema } from "@/lib/validation/content";

import { formatDate, formatDateTime, isoToLocalInput, localInputToIso } from "./datetime";

// Run the conversions in a non-UTC zone (UTC+7, no DST) to prove they really
// convert between local time and UTC.
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Ho_Chi_Minh";
});
afterAll(() => {
  process.env.TZ = originalTz;
});

describe("localInputToIso", () => {
  it("converts browser-local time to UTC ISO 8601", () => {
    expect(localInputToIso("2026-12-01T09:00")).toBe("2026-12-01T02:00:00.000Z");
    expect(localInputToIso("2026-12-01T09:00:30")).toBe("2026-12-01T02:00:30.000Z");
    expect(localInputToIso("2026-12-01T03:00")).toBe("2026-11-30T20:00:00.000Z");
  });

  it("treats empty as not scheduled", () => {
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("  ")).toBeNull();
  });

  it.each(["2026-02-31T09:00", "2026-13-01T09:00", "tomorrow", "2026-12-01", "2026-12-01T09:00Z"])(
    "rejects %j",
    (value) => {
      expect(localInputToIso(value)).toBeUndefined();
    },
  );

  it("produces values the backend validation accepts unchanged", () => {
    const iso = localInputToIso("2026-12-01T09:00")!;
    const parsed = postInputSchema.parse({ title: "t", body: "", status: "draft", scheduledFor: iso });
    expect(parsed.scheduledFor).toBe(iso);
  });
});

describe("isoToLocalInput", () => {
  it("renders a stored UTC time in local time for the input", () => {
    expect(isoToLocalInput("2026-12-01T02:00:00.000Z")).toBe("2026-12-01T09:00");
    expect(isoToLocalInput("2026-12-01T02:00:00.123456+00:00")).toBe("2026-12-01T09:00");
  });

  it("round-trips with localInputToIso", () => {
    expect(localInputToIso(isoToLocalInput("2026-12-01T02:00:00Z"))).toBe("2026-12-01T02:00:00.000Z");
  });

  it.each([null, undefined, "", "garbage"])("returns an empty string for %j", (value) => {
    expect(isoToLocalInput(value)).toBe("");
  });
});

describe("formatDateTime / formatDate (Vietnamese format)", () => {
  it("formats deterministically in UTC as dd/MM/yyyy HH:mm", () => {
    expect(formatDateTime("2026-12-01T02:05:00Z", { timeZone: "UTC" })).toBe("01/12/2026 02:05");
  });

  it("formats in local time by default, 24-hour clock", () => {
    expect(formatDateTime("2026-12-01T02:05:00Z")).toBe("01/12/2026 09:05");
    expect(formatDateTime("2026-12-01T10:30:00Z")).toBe("01/12/2026 17:30");
  });

  it("shows the local calendar day", () => {
    expect(formatDate("2026-11-30T20:00:00Z")).toBe("01/12/2026");
    expect(formatDate("2026-11-30T20:00:00Z", { timeZone: "UTC" })).toBe("30/11/2026");
  });

  it("returns an empty string for invalid input", () => {
    expect(formatDateTime("nope")).toBe("");
    expect(formatDate("nope")).toBe("");
  });
});
