import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn(), log: vi.fn() }));
vi.mock("./worker", () => ({ readSportsNewsConfig: mocks.read, runSportsDelivery: mocks.run }));
vi.mock("@/lib/logging/safe-log", () => ({ logSafeError: mocks.log, safeErrorInfo: () => ({ type: "Error" }) }));

import { dispatchApprovedDeliveries } from "./dispatch";

const WS = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockReturnValue({ workspaceId: WS });
  mocks.run.mockResolvedValue({});
});

describe("dispatchApprovedDeliveries", () => {
  it("is a no-op when the worker is not configured", async () => {
    mocks.read.mockImplementation(() => { throw new Error("missing env"); });
    await dispatchApprovedDeliveries(WS);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("ignores other workspaces", async () => {
    await dispatchApprovedDeliveries("99999999-9999-4999-8999-999999999999");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("coalesces concurrent calls into one running worker plus one follow-up run", async () => {
    let release!: () => void;
    mocks.run.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const calls = Array.from({ length: 8 }, () => dispatchApprovedDeliveries(WS));
    await Promise.resolve();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    release();
    await Promise.all(calls);
    expect(mocks.run).toHaveBeenCalledTimes(2); // the follow-up catches approvals made mid-run
  });

  it("never throws and logs only safe fields when the worker fails", async () => {
    mocks.run.mockRejectedValue(new Error("secret-token-123"));
    await expect(dispatchApprovedDeliveries(WS)).resolves.toBeUndefined();
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("secret-token-123");
  });
});
