import "server-only";

import { contentClient } from "@/lib/content/client";
import { ContentError, parseContentInput, toContentError } from "@/lib/content/errors";
import { profileIdsSchema, profileUpdateSchema } from "@/lib/validation/profile";

/**
 * User profiles (display names), always through the signed-in user's Supabase
 * client (RLS: own profile + fellow members of a shared workspace). No email,
 * no service-role key. A user may have no profile yet: callers get null.
 */

export type MyProfile = { displayName: string; updatedAt: string };

/** The signed-in user's profile, or null when they have not set a name yet. */
export async function getMyProfile(): Promise<MyProfile | null> {
  const { supabase, user } = await contentClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .select("display_name, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw toContentError(error);
  return data ? { displayName: data.display_name, updatedAt: data.updated_at } : null;
}

/**
 * Creates or renames the signed-in user's profile. Input is only the display
 * name (strict schema: a user_id or any other key is rejected); the database
 * takes the user id from the session.
 */
export async function updateMyDisplayName(input: unknown): Promise<MyProfile> {
  const { displayName } = parseContentInput(profileUpdateSchema, input);
  const { supabase } = await contentClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .upsert({ display_name: displayName }, { onConflict: "user_id" })
    .select("display_name, updated_at")
    .single();
  if (error) throw toContentError(error);
  if (!data) throw new ContentError("unknown");
  return { displayName: data.display_name, updatedAt: data.updated_at };
}

/**
 * Display names of the given users that the caller may see (RLS). Users without
 * a profile, or not sharing a workspace with the caller, are simply missing.
 */
export async function listDisplayNames(userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  const parsed = profileIdsSchema.safeParse(ids);
  if (!parsed.success) throw new ContentError("invalid_input");
  if (parsed.data.length === 0) return new Map();
  const { supabase } = await contentClient();
  const { data, error } = await supabase.from("user_profiles").select("user_id, display_name").in("user_id", parsed.data);
  if (error) throw toContentError(error);
  return new Map((data ?? []).map((row) => [row.user_id, row.display_name]));
}

type AuthedClient = Awaited<ReturnType<typeof contentClient>>["supabase"];

/**
 * Saves the display name chosen at sign-up with the client that has just been
 * signed in (the session cookie of a Server Action is not readable again in the
 * same request). Best effort: a failure never blocks sign-up; the user can set
 * the name later on the account page. Returns whether it was saved.
 */
export async function saveSignupDisplayName(supabase: AuthedClient, displayName: string): Promise<boolean> {
  const parsed = profileUpdateSchema.safeParse({ displayName });
  if (!parsed.success) return false;
  const { error } = await supabase
    .from("user_profiles")
    .upsert({ display_name: parsed.data.displayName }, { onConflict: "user_id" });
  return !error;
}

/**
 * After email confirmation: creates the profile from the name given at sign-up
 * (kept in the user's own auth metadata until a session exists), unless the user
 * already has a profile. Best effort, never throws.
 */
export async function ensureProfileFromSignup(supabase: AuthedClient): Promise<void> {
  try {
    const { data } = await supabase.auth.getUser();
    const user = data.user;
    const name = user?.user_metadata?.display_name;
    if (!user || typeof name !== "string") return;
    const { data: existing } = await supabase.from("user_profiles").select("user_id").eq("user_id", user.id).maybeSingle();
    if (existing) return;
    await saveSignupDisplayName(supabase, name);
  } catch {
    // Optional convenience: never block the confirmation redirect.
  }
}
