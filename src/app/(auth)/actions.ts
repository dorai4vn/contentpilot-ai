"use server";

import { redirect } from "next/navigation";

import { safeRedirectPath } from "@/lib/auth/routes";
import { MissingConfigurationError } from "@/lib/env";
import { getSiteOrigin } from "@/lib/site-url";
import { logSafeError } from "@/lib/logging/safe-log";
import { saveSignupDisplayName } from "@/lib/profiles/profiles";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsFrom, parseCredentials, type FormState } from "@/lib/validation/auth";
import { optionalDisplayNameSchema } from "@/lib/validation/profile";

const NOT_CONFIGURED = "Chức năng đăng nhập chưa được cấu hình trên bản triển khai này.";

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
        ? "Vui lòng xác nhận địa chỉ email trước. Hãy mở liên kết xác nhận trong hộp thư của bạn."
        : "Email hoặc mật khẩu không đúng.";
    return { error: message, values: { email } };
  }

  redirect(safeRedirectPath(formData.get("next")));
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseCredentials(formData);
  const email = String(formData.get("email") ?? "");
  const rawName = formData.get("displayName");
  const nameInput = typeof rawName === "string" ? rawName : "";
  const name = optionalDisplayNameSchema.safeParse(nameInput);
  if (!parsed.success || !name.success) {
    return {
      fieldErrors: {
        ...(parsed.success ? {} : fieldErrorsFrom(parsed.error)),
        ...(name.success ? {} : { displayName: name.error.issues[0]?.message ?? "Tên hiển thị không hợp lệ." }),
      },
      values: { email, displayName: nameInput },
    };
  }
  const displayName = name.data;

  const supabase = await getClientOrNull();
  if (!supabase) return { error: NOT_CONFIGURED, values: { email, displayName: nameInput } };

  const origin = await getSiteOrigin();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: {
      emailRedirectTo: `${origin}/auth/confirm?next=/dashboard`,
      // Kept in the user's own metadata until a session exists (email confirmation);
      // the profile is created from it at /auth/confirm. Never contains the email.
      ...(displayName ? { data: { display_name: displayName } } : {}),
    },
  });

  if (error) {
    const message =
      error.code === "weak_password"
        ? "Mật khẩu quá yếu. Hãy dùng mật khẩu dài hơn và khó đoán hơn."
        : error.code === "over_email_send_rate_limit"
          ? "Bạn đã thử đăng ký quá nhiều lần. Vui lòng đợi vài phút rồi thử lại."
          : "Không thể tạo tài khoản. Vui lòng thử lại.";
    return { error: message, values: { email } };
  }

  // Email confirmation disabled in Supabase: the user is signed in immediately.
  if (data.session) {
    if (displayName && !(await saveSignupDisplayName(supabase, displayName))) {
      // Optional: the account is created anyway; the name can be set on /account.
      logSafeError("signup", { event: "profile_not_saved" });
    }
    redirect("/dashboard");
  }

  // Same response whether or not the email already exists (no account enumeration).
  return {
    message: "Hãy mở email để nhấn vào liên kết xác nhận, sau đó đăng nhập.",
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
