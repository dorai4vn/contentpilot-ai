import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabaseEnv } from "@/lib/env";
import type { Database } from "@/types/database";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * It acts as the signed-in user (from the auth cookies), so every query is
 * subject to Row Level Security. Create a new client per request.
 */
export async function createClient() {
  // Read cookies first: this marks the route as request-time rendered.
  const cookieStore = await cookies();
  const { url, key } = getSupabaseEnv();

  return createServerClient<Database>(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // The proxy refreshes the session cookies on every request instead.
        }
      },
    },
  });
}
