/**
 * Safety guard for integration tests: they create users and data, so they must
 * only ever run against a LOCAL, disposable Supabase stack (`npx supabase start`).
 */

const LOCAL_HTTP = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
const LOCAL_PG = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

export type LocalTarget = { supabaseUrl: string; supabaseKey: string; dbUrl: string };

/** Returns the target or throws (without echoing secrets) when anything is not local. */
export function assertLocalTarget(env: Record<string, string | undefined>): LocalTarget {
  const supabaseUrl = (env.INTEGRATION_SUPABASE_URL ?? "").trim();
  const supabaseKey = (env.INTEGRATION_SUPABASE_KEY ?? "").trim();
  const dbUrl = (env.LOCAL_DB_URL ?? "").trim();

  if (!LOCAL_HTTP.test(supabaseUrl)) {
    throw new Error("Refusing to run: INTEGRATION_SUPABASE_URL must point to localhost / 127.0.0.1.");
  }
  if (!LOCAL_PG.test(dbUrl)) {
    throw new Error("Refusing to run: LOCAL_DB_URL must point to localhost / 127.0.0.1.");
  }
  if (supabaseKey.length < 20) {
    throw new Error("Refusing to run: INTEGRATION_SUPABASE_KEY (local publishable/anon key) is missing.");
  }
  if (/supabase\.(co|in|net)\b/i.test(supabaseUrl + dbUrl)) {
    throw new Error("Refusing to run: a hosted Supabase project was detected.");
  }
  return { supabaseUrl, supabaseKey, dbUrl };
}
