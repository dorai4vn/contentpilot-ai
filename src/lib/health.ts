import { z } from "zod";

/** Shape returned by the public.health_check() SQL function. */
const healthRowSchema = z.object({
  ok: z.literal(true),
  server_time: z.string(),
  server_version: z.number(),
});

export type HealthReport =
  | {
      status: "ok";
      database: { connected: true; latencyMs: number; serverTime: string; serverVersion: number };
      checkedAt: string;
    }
  | {
      status: "error";
      database: { connected: false; latencyMs: number | null; error: string };
      checkedAt: string;
    };

/** Minimal surface of the Supabase client that the probe needs (eases testing). */
export type HealthRpcClient = {
  rpc: (fn: "health_check") => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

type Clock = () => number;

/**
 * Runs a real query on Postgres (via the health_check() function exposed by
 * PostgREST) and reports whether the database answered correctly.
 * Error messages are generic on purpose: no internals are leaked publicly.
 */
export async function checkDatabase(
  client: HealthRpcClient | null,
  now: Clock = () => performance.now(),
): Promise<HealthReport> {
  const checkedAt = new Date().toISOString();

  if (!client) {
    return {
      status: "error",
      database: { connected: false, latencyMs: null, error: "Database is not configured" },
      checkedAt,
    };
  }

  const started = now();
  try {
    const { data, error } = await client.rpc("health_check");
    const latencyMs = Math.round(now() - started);

    if (error) {
      return { status: "error", database: { connected: false, latencyMs, error: "Database query failed" }, checkedAt };
    }

    const parsed = healthRowSchema.safeParse(data);
    if (!parsed.success) {
      return {
        status: "error",
        database: { connected: false, latencyMs, error: "Unexpected database response" },
        checkedAt,
      };
    }

    return {
      status: "ok",
      database: {
        connected: true,
        latencyMs,
        serverTime: parsed.data.server_time,
        serverVersion: parsed.data.server_version,
      },
      checkedAt,
    };
  } catch {
    return {
      status: "error",
      database: { connected: false, latencyMs: Math.round(now() - started), error: "Database unreachable" },
      checkedAt,
    };
  }
}
