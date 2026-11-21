"use client";

import Link from "next/link";
import { useActionState } from "react";

import type { FormState } from "@/lib/validation/auth";

type Mode = "login" | "signup";

type Props = {
  mode: Mode;
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  next?: string;
  notice?: string;
};

const copy: Record<Mode, { submit: string; pending: string; switchText: string; switchHref: string; switchLabel: string }> = {
  login: {
    submit: "Đăng nhập",
    pending: "Đang đăng nhập…",
    switchText: "Chưa có tài khoản?",
    switchHref: "/signup",
    switchLabel: "Đăng ký ngay",
  },
  signup: {
    submit: "Tạo tài khoản",
    pending: "Đang tạo tài khoản…",
    switchText: "Đã có tài khoản?",
    switchHref: "/login",
    switchLabel: "Đăng nhập",
  },
};

export function AuthForm({ mode, action, next, notice }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const text = copy[mode];

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {notice && !state.error && !state.message ? (
        <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200">
          {notice}
        </p>
      ) : null}

      {mode === "signup" ? (
        <label className="flex flex-col gap-1 text-sm font-medium">
          <span>
            Tên hiển thị <span className="font-normal text-slate-500">(không bắt buộc)</span>
          </span>
          <input
            name="displayName"
            type="text"
            autoComplete="name"
            maxLength={60}
            defaultValue={state.values?.displayName}
            aria-invalid={Boolean(state.fieldErrors?.displayName)}
            data-testid="signup-display-name"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <span className="text-xs font-normal text-slate-500">
            Thành viên trong các không gian làm việc của bạn sẽ thấy tên này. Email không được hiển thị.
          </span>
          {state.fieldErrors?.displayName ? (
            <span className="text-xs text-red-600">{state.fieldErrors.displayName}</span>
          ) : null}
        </label>
      ) : null}

      <label className="flex flex-col gap-1 text-sm font-medium">
        Email
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.values?.email}
          aria-invalid={Boolean(state.fieldErrors?.email)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        {state.fieldErrors?.email ? <span className="text-xs text-red-600">{state.fieldErrors.email}</span> : null}
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Mật khẩu
        <input
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={8}
          aria-invalid={Boolean(state.fieldErrors?.password)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        {state.fieldErrors?.password ? (
          <span className="text-xs text-red-600">{state.fieldErrors.password}</span>
        ) : null}
      </label>

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? text.pending : text.submit}
      </button>

      <p className="text-center text-sm text-slate-600 dark:text-slate-400">
        {text.switchText}{" "}
        <Link href={text.switchHref} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          {text.switchLabel}
        </Link>
      </p>
    </form>
  );
}
