import { createClient } from "@supabase/supabase-js";

import { readSupabaseEnv } from "@/lib/env";
import { checkDatabase } from "@/lib/health";
import type { Database } from "@/types/database";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — public liveness + database connectivity probe.
 * 200 when Postgres answered a real query, 503 otherwise.
 */
export async function GET() {
  const env = readSupabaseEnv();
  const client = env
    ? createClient<Database>(env.url, env.key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

  const report = await checkDatabase(client);

  return Response.json(
    { service: "contentpilot-ai", ...report },
    {
      status: report.status === "ok" ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
