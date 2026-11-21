import type { Metadata } from "next";

import { signUp } from "../actions";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Tạo tài khoản" };

export default function SignupPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-slate-900">Tạo tài khoản</h1>
      <p className="mb-6 text-sm text-slate-600">Mật khẩu cần có ít nhất 8 ký tự.</p>
      <AuthForm mode="signup" action={signUp} />
    </>
  );
}
