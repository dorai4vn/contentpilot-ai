import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(), deliver: vi.fn(), full: vi.fn(), setup: vi.fn(),
}));
vi.mock("@/lib/sports-news/worker", () => ({
  readSportsNewsConfig: mocks.config, runSportsDelivery: mocks.deliver,
  runSportsNews: mocks.full, checkSportsNewsSetup: mocks.setup,
}));

import { POST, maxDuration } from "./route";

const call = (query: string, auth?: string) =>
  POST(new Request(`https://x.test/api/cron/sports-news${query}`, {
    method: "POST", headers: auth ? { authorization: auth } : {},
  }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "unit-test-secret";
  mocks.config.mockReturnValue({ workspaceId: "w" });
  mocks.deliver.mockResolvedValue({ rounds: 1, claimed: 0 });
});

describe("POST /api/cron/sports-news?mode=deliver", () => {
  it("rejects missing or wrong bearer before touching the worker", async () => {
    expect((await call("?mode=deliver")).status).toBe(401);
    expect((await call("?mode=deliver", "Bearer nope")).status).toBe(401);
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("runs delivery only: no RSS/LLM pipeline", async () => {
    const response = await call("?mode=deliver", "Bearer unit-test-secret");
    expect(response.status).toBe(200);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.full).not.toHaveBeenCalled();
  });

  it("returns a generic error when delivery fails", async () => {
    mocks.deliver.mockRejectedValue(new Error("db password leaked"));
    const response = await call("?mode=deliver", "Bearer unit-test-secret");
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("leaked");
  });

  it("stays inside the documented duration budget", () => {
    expect(maxDuration).toBe(180);
  });
});
