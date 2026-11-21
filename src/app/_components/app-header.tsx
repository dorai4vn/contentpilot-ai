import Link from "next/link";

import { signOut } from "@/app/(auth)/actions";

/** Top bar shared by the dashboard and the content pages. */
export function AppHeader({ email }: { email: string | null }) {
  return (
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/dashboard" className="font-semibold tracking-tight">
          ContentPilot <span className="text-indigo-600">AI</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden text-slate-600 sm:inline dark:text-slate-400" data-testid="user-email">
            {email}
          </span>
          <Link
            href="/account"
            className="rounded-md px-2 py-1.5 font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            data-testid="account-link"
          >
            Tài khoản
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Đăng xuất
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
