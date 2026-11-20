import Link from "next/link";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 block text-center text-xl font-semibold tracking-tight">
          ContentPilot <span className="text-indigo-600">AI</span>
        </Link>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          {children}
        </div>
      </div>
    </main>
  );
}
