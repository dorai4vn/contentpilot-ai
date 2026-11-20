import type { Metadata } from "next";

import { safeRedirectPath } from "@/lib/auth/routes";

import { signIn } from "../actions";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Sign in" };

const notices: Record<string, string> = {
  signed_out: "You have been signed out.",
  confirm_failed: "That confirmation link is invalid or has expired. Please sign in or sign up again.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeRedirectPath(typeof params.next === "string" ? params.next : undefined);
  const notice = params.signed_out ? notices.signed_out : params.error === "confirm_failed" ? notices.confirm_failed : undefined;

  return (
    <>
      <h1 className="mb-1 text-lg font-semibold">Sign in</h1>
      <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">Use your email and password.</p>
      <AuthForm mode="login" action={signIn} next={next} notice={notice} />
    </>
  );
}
