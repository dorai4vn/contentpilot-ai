import { describe, expect, it } from "vitest";

import { checkDatabase, type HealthRpcClient } from "./health";

// Test doubles for the Supabase RPC transport. The production route always uses
// the real Supabase client; these only exercise the response handling logic.
function clientReturning(result: { data: unknown; error: { message: string } | null }): HealthRpcClient {
  return { rpc: async () => result };
}

const ticking = () => {
  let t = 0;
  return () => (t += 5);
};

describe("checkDatabase", () => {
  it("reports not configured when there is no client", async () => {
    const report = await checkDatabase(null);
    expect(report.status).toBe("error");
    expect(report.database).toMatchObject({ connected: false, error: "Database is not configured" });
  });

  it("reports ok when the database answers", async () => {
    const report = await checkDatabase(
      clientReturning({ data: { ok: true, server_time: "2026-11-20T00:00:00Z", server_version: 170004 }, error: null }),
      ticking(),
    );
    expect(report).toMatchObject({
      status: "ok",
      database: { connected: true, latencyMs: 5, serverVersion: 170004 },
    });
  });

  it("reports an error without leaking details when the query fails", async () => {
    const report = await checkDatabase(clientReturning({ data: null, error: { message: "relation secret_x missing" } }));
    expect(report.status).toBe("error");
    expect(JSON.stringify(report)).not.toContain("secret_x");
  });

  it("rejects an unexpected payload", async () => {
    const report = await checkDatabase(clientReturning({ data: { ok: "yes" }, error: null }));
    expect(report.database).toMatchObject({ connected: false, error: "Unexpected database response" });
  });

  it("handles network failures", async () => {
    const client: HealthRpcClient = {
      rpc: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const report = await checkDatabase(client);
    expect(report.database).toMatchObject({ connected: false, error: "Database unreachable" });
  });
});
