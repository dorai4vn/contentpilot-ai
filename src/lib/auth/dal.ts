import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { MissingConfigurationError } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export type CurrentUser = {
  id: string;
  email: string | null;
};

/**
 * Data Access Layer entry point: returns the verified current user or null.
 * `auth.getUser()` asks the Supabase Auth server to validate the session, so a
 * forged or revoked cookie is rejected. Memoised per request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  let supabase;
  try {
    supabase = await createClient();
  } catch (error) {
    // Not configured yet: behave as signed out (pages show a configuration notice).
    if (error instanceof MissingConfigurationError) return null;
    throw error;
  }
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
});

/** Use at the top of every protected page, action and route handler. */
export async function requireUser(nextPath = "/dashboard"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  return user;
}
