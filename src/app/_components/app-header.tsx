import { LogOut, Trophy, UserRound } from "lucide-react";
import Link from "next/link";

import { signOut } from "@/app/(auth)/actions";
import { ThemeControl } from "./theme-control";

/** Brand mark used by the top bar, the auth pages and the home page. */
export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight text-slate-900 ${className}`}>
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-700 text-white shadow-sm">
        <Trophy className="h-4 w-4" aria-hidden />
      </span>
      <span className="max-[380px]:sr-only">Social <span className="hidden text-emerald-700 sm:inline">Automation</span></span>
    </span>
  );
}

/** Sticky top bar shared by the dashboard and the content pages. */
export function AppHeader({ email }: { email: string | null }) {
  const initial = (email ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <header className="football-topbar sticky top-0 z-30 border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-16 max-w-screen-2xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/dashboard" className="rounded-lg" aria-label="Social Automation — Bảng điều khiển">
          <BrandMark />
        </Link>
        <div className="flex items-center gap-1.5 text-sm sm:gap-2">
          <ThemeControl />
          <span className="hidden items-center gap-2 rounded-full border border-slate-200 bg-slate-50 py-1 pl-1 pr-3 md:inline-flex">
            <span
              className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700"
              aria-hidden
            >
              {initial}
            </span>
            <span className="max-w-[14rem] truncate text-slate-600" data-testid="user-email">
              {email}
            </span>
          </span>
          <Link
            href="/account"
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900"
            data-testid="account-link"
          >
            <UserRound className="h-4 w-4" aria-hidden />
            <span className="max-sm:sr-only">Tài khoản</span>
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-medium text-slate-700 shadow-xs hover:bg-slate-50 hover:text-slate-900"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              <span className="max-sm:sr-only">Đăng xuất</span>
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
