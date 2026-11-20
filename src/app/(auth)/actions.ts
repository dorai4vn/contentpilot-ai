"use server";

import { redirect } from "next/navigation";

import { safeRedirectPath } from "@/lib/auth/routes";
import { MissingConfigurationError } from "@/lib/env";
import { getSiteOrigin } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsFrom, parseCredentials, type FormState } from "@/lib/validation/auth";

const NOT_CONFIGURED = "Authentication is not configured on this deployment yet.";

async function getClientOrNull() {
  try {
    return await createClient();
  } catch (error) {
    if (error instanceof MissingConfigurationError) return null;
    throw error;
  }
}

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseCredentials(formData);
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error), values: { email } };
  }

  const supabase = await getClientOrNull();
  if (!supabase) return { error: NOT_CONFIGURED, values: { email } };

  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    const message =
      error.code === "email_not_confirmed"
        ? "Please confirm your email address first. Check your inbox for the confirmation link."
        : "Invalid email or password.";
    return { error: message, values: { email } };
  }

  redirect(safeRedirectPath(formData.get("next")));
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseCredentials(formData);
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error), values: { email } };
  }

  const supabase = await getClientOrNull();
  if (!supabase) return { error: NOT_CONFIGURED, values: { email } };

  const origin = await getSiteOrigin();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${origin}/auth/confirm?next=/dashboard` },
  });

  if (error) {
    const message =
      error.code === "weak_password"
        ? "That password is too weak. Use a longer, less common password."
        : error.code === "over_email_send_rate_limit"
          ? "Too many sign-up attempts. Please wait a few minutes and try again."
          : "Could not create the account. Please try again.";
    return { error: message, values: { email } };
  }

  // Email confirmation disabled in Supabase: the user is signed in immediately.
  if (data.session) {
    redirect("/dashboard");
  }

  // Same response whether or not the email already exists (no account enumeration).
  return {
    message: "Check your email for a confirmation link, then sign in.",
    values: { email },
  };
}

export async function signOut(): Promise<void> {
  const supabase = await getClientOrNull();
  if (supabase) {
    await supabase.auth.signOut();
  }
  redirect("/login?signed_out=1");
}
