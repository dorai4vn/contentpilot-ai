import { describe, expect, it } from "vitest";
import { AutomationOffError, assertAutomationNotOff, automationModeSchema, readAutomationMode } from "./automation-mode";

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
  it("validates mode and daily quota bounds", () => {
    expect(automationModeSchema.safeParse({ mode: "auto", dailyQuota: "40" }).success).toBe(true);
    for (const bad of [{ mode: "x", dailyQuota: 5 }, { mode: "auto", dailyQuota: 0 }, { mode: "auto", dailyQuota: 121 }, { mode: "auto", dailyQuota: 1.5 }]) {
      expect(automationModeSchema.safeParse(bad).success).toBe(false);
    }
  });
});
