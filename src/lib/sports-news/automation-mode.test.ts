import { describe, expect, it } from "vitest";
import { AutomationOffError, assertAutomationNotOff, automationModeSchema, readAutomationMode,
  AUTOMATION_DAILY_QUOTA_DEFAULT, AUTOMATION_POSTS_PER_SCAN_DEFAULT, AUTOMATION_SCAN_INTERVAL_DEFAULT_HOURS } from "./automation-mode";

const client = (result: { data: { mode: string; daily_quota: number }[] | null; error: unknown }) => ({ rpc: async () => result });

describe("automation mode", () => {
  it("reads the three modes", async () => {
    for (const mode of ["off", "semi", "auto"] as const) {
      expect(await readAutomationMode(client({ data: [{ mode, daily_quota: 40 }], error: null }), "w", "p")).toBe(mode);
    }
  });
  it("fails closed to Off on error, empty or unknown data", async () => {
    expect(await readAutomationMode(client({ data: null, error: { message: "x" } }), "w", "p")).toBe("off");
    expect(await readAutomationMode(client({ data: [], error: null }), "w", "p")).toBe("off");
    expect(await readAutomationMode(client({ data: [{ mode: "turbo", daily_quota: 1 }], error: null }), "w", "p")).toBe("off");
  });
  it("checkpoint throws only when Off", async () => {
    await expect(assertAutomationNotOff(client({ data: [{ mode: "off", daily_quota: 1 }], error: null }), "w", "p")).rejects.toBeInstanceOf(AutomationOffError);
    await expect(assertAutomationNotOff(client({ data: [{ mode: "auto", daily_quota: 1 }], error: null }), "w", "p")).resolves.toBeUndefined();
  });
  it("validates mode, daily quota, scan interval and posts-per-scan bounds", () => {
    const ok = { mode: "auto", dailyQuota: "20", scanIntervalHours: "2", postsPerScan: "2" };
    expect(automationModeSchema.safeParse(ok).success).toBe(true);
    expect(automationModeSchema.safeParse({ ...ok, dailyQuota: 120, scanIntervalHours: 24, postsPerScan: 10 }).success).toBe(true);
    expect(automationModeSchema.safeParse({ ...ok, dailyQuota: 1, scanIntervalHours: 12, postsPerScan: 1 }).success).toBe(true);
    for (const bad of [
      { mode: "x" }, { dailyQuota: 0 }, { dailyQuota: 121 }, { dailyQuota: 1.5 },
      { scanIntervalHours: 1 }, { scanIntervalHours: 3 }, { scanIntervalHours: 26 }, { scanIntervalHours: 0 }, { scanIntervalHours: 2.5 },
      { postsPerScan: 0 }, { postsPerScan: 11 }, { postsPerScan: 1.5 }, { postsPerScan: "" },
    ]) {
      expect(automationModeSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("exposes the owner-approved defaults 20/day, 2h, 2 posts per scan", () => {
    expect([AUTOMATION_DAILY_QUOTA_DEFAULT, AUTOMATION_SCAN_INTERVAL_DEFAULT_HOURS, AUTOMATION_POSTS_PER_SCAN_DEFAULT]).toEqual([20, 2, 2]);
  });
});
