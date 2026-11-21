import type { Metadata } from "next";

import { safeRedirectPath } from "@/lib/auth/routes";

import { signIn } from "../actions";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Đăng nhập" };

const notices: Record<string, string> = {
  signed_out: "Bạn đã đăng xuất.",
  confirm_failed: "Liên kết xác nhận không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập hoặc đăng ký lại.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeRedirectPath(typeof params.next === "string" ? params.next : undefined);
  const notice = params.signed_out ? notices.signed_out : params.error === "confirm_failed" ? notices.confirm_failed : undefined;

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-slate-900">Đăng nhập</h1>
      <p className="mb-6 text-sm text-slate-600">Dùng email và mật khẩu của bạn.</p>
      <AuthForm mode="login" action={signIn} next={next} notice={notice} />
    </>
  );
}
