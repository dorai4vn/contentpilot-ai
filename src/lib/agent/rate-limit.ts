/**
 * Per-user request limiter for /api/agent (in memory, per server instance).
 *
 * Purpose: reduce spam and OpenAI cost. It complements, not replaces, the
 * per-turn limits of the agent loop (6 tool calls, 3 writes, 45 s).
 * On a serverless platform each instance has its own memory, so this is a
 * best-effort limit; a shared store (database/Redis) would make it global.
 */

export const AGENT_RATE_LIMITS = {
  /** Requests per user per window. */
  maxRequests: 5,
  windowMs: 60_000,
  /** Requests a user may have running at the same time. */
  maxConcurrent: 1,
  /** Users tracked at once (memory bound); the oldest entries are dropped. */
  maxTrackedUsers: 5_000,
} as const;

export type RateLimitDecision =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: "too_many_requests" | "concurrent_request"; retryAfterSeconds: number };

type Entry = { timestamps: number[]; active: number };

export class AgentRateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly limits: {
      maxRequests: number;
      windowMs: number;
      maxConcurrent: number;
      maxTrackedUsers: number;
    } = AGENT_RATE_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Checks and, if allowed, records a request. Call `release()` when it finishes. */
  acquire(userId: string): RateLimitDecision {
    const now = this.now();
    const entry = this.entries.get(userId) ?? { timestamps: [], active: 0 };
    entry.timestamps = entry.timestamps.filter((t) => now - t < this.limits.windowMs);

    if (entry.active >= this.limits.maxConcurrent) {
      this.store(userId, entry);
      return { allowed: false, reason: "concurrent_request", retryAfterSeconds: 5 };
    }
    if (entry.timestamps.length >= this.limits.maxRequests) {
      const oldest = entry.timestamps[0]!;
      this.store(userId, entry);
      return {
        allowed: false,
        reason: "too_many_requests",
        retryAfterSeconds: Math.max(1, Math.ceil((this.limits.windowMs - (now - oldest)) / 1000)),
      };
    }

    entry.timestamps.push(now);
    entry.active += 1;
    this.store(userId, entry);

    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(userId);
        if (current) current.active = Math.max(0, current.active - 1);
      },
    };
  }

  reset(): void {
    this.entries.clear();
  }

  private store(userId: string, entry: Entry) {
    // Re-insert to keep Map order = least recently used first.
    this.entries.delete(userId);
    this.entries.set(userId, entry);
    while (this.entries.size > this.limits.maxTrackedUsers) {
      const oldestKey = this.entries.keys().next().value as string;
      if (this.entries.get(oldestKey)?.active) break; // never drop a user with a running request
      this.entries.delete(oldestKey);
    }
  }
}

/** Shared limiter for the route (one per server instance). */
export const agentRateLimiter = new AgentRateLimiter();
