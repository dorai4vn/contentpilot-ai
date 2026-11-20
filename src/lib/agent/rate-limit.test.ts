import { describe, expect, it } from "vitest";

import { AGENT_RATE_LIMITS, AgentRateLimiter } from "./rate-limit";

function limiter(overrides: Partial<Record<keyof typeof AGENT_RATE_LIMITS, number>> = {}) {
  let now = 1_000_000;
  const instance = new AgentRateLimiter({ ...AGENT_RATE_LIMITS, ...overrides }, () => now);
  return { instance, advance: (ms: number) => (now += ms) };
}

describe("AgentRateLimiter", () => {
  it(`allows ${AGENT_RATE_LIMITS.maxRequests} requests per minute, then answers with Retry-After`, () => {
    const { instance, advance } = limiter();
    for (let i = 0; i < AGENT_RATE_LIMITS.maxRequests; i++) {
      const decision = instance.acquire("u1");
      expect(decision.allowed).toBe(true);
      if (decision.allowed) decision.release();
      advance(1_000);
    }
    const blocked = instance.acquire("u1");
    // Requests at t = 0..4 s, this one at t = 5 s: the oldest expires at t = 60 s.
    expect(blocked).toEqual({ allowed: false, reason: "too_many_requests", retryAfterSeconds: 55 });

    advance(54_000);
    expect(instance.acquire("u1").allowed).toBe(false);
    advance(1_000);
    expect(instance.acquire("u1").allowed).toBe(true);
  });

  it("allows only one running request per user", () => {
    const { instance } = limiter();
    const first = instance.acquire("u1");
    expect(first.allowed).toBe(true);
    expect(instance.acquire("u1")).toMatchObject({ allowed: false, reason: "concurrent_request" });
    if (first.allowed) first.release();
    expect(instance.acquire("u1").allowed).toBe(true);
  });

  it("counts users separately", () => {
    const { instance } = limiter({ maxRequests: 1 });
    const a = instance.acquire("u1");
    if (a.allowed) a.release();
    expect(instance.acquire("u1").allowed).toBe(false);
    expect(instance.acquire("u2").allowed).toBe(true);
  });

  it("release is idempotent", () => {
    const { instance } = limiter({ maxConcurrent: 1 });
    const a = instance.acquire("u1");
    if (!a.allowed) throw new Error("expected allowed");
    a.release();
    a.release();
    const b = instance.acquire("u1");
    expect(b.allowed).toBe(true);
    expect(instance.acquire("u1").allowed).toBe(false); // b is still running
  });

  it("bounds memory and never forgets a running request", () => {
    const { instance } = limiter({ maxTrackedUsers: 2, maxRequests: 1 });
    const running = instance.acquire("u1");
    expect(running.allowed).toBe(true);
    for (const id of ["u2", "u3", "u4"]) {
      const d = instance.acquire(id);
      if (d.allowed) d.release();
    }
    expect(instance.acquire("u1")).toMatchObject({ allowed: false, reason: "concurrent_request" });
  });
});
