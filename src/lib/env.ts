import { z } from "zod";

/**
 * Public Supabase configuration. These values are safe to expose to the browser:
 * access control is enforced by Postgres Row Level Security, not by hiding the key.
 *
 * The publishable key is Supabase's current name for the client key; the legacy
 * `anon` key is accepted as a fallback.
 */
const supabaseEnvSchema = z.object({
  url: z.url({ message: "NEXT_PUBLIC_SUPABASE_URL must be a valid URL" }),
  key: z.string().min(20, { message: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing or too short" }),
});

export type SupabaseEnv = z.infer<typeof supabaseEnvSchema>;

export class MissingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingConfigurationError";
  }
}

type EnvSource = Record<string, string | undefined>;

// Next.js inlines NEXT_PUBLIC_* only when referenced literally, so read them explicitly.
function defaultSource(): EnvSource {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}

/** Returns the Supabase config, or null when it is not configured. */
export function readSupabaseEnv(source: EnvSource = defaultSource()): SupabaseEnv | null {
  const parsed = supabaseEnvSchema.safeParse({
    url: source.NEXT_PUBLIC_SUPABASE_URL?.trim(),
    key: (source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || source.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim(),
  });
  return parsed.success ? parsed.data : null;
}

/** Returns the Supabase config or throws a descriptive error. */
export function getSupabaseEnv(source?: EnvSource): SupabaseEnv {
  const env = readSupabaseEnv(source);
  if (!env) {
    throw new MissingConfigurationError(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (see .env.example).",
    );
  }
  return env;
}
