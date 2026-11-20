import "server-only";

import { getCurrentUser } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";

import { ContentError } from "./errors";

/**
 * Supabase client acting as the signed-in user (RLS applies). Callers (pages,
 * Server Actions) must already have called requireUser(); this re-check makes the
 * data layer safe on its own. Never uses the service-role key.
 */
export async function contentClient() {
  const user = await getCurrentUser();
  if (!user) throw new ContentError("unauthenticated");
  return { supabase: await createClient(), user };
}
