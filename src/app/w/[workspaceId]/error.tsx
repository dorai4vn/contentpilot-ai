"use client";

import Link from "next/link";

import { buttonClass } from "../_components/ui";

/** Unexpected failure while loading content. Details stay in the server logs. */
export default function ContentError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 dark:border-red-900 dark:bg-red-950">
      <h2 className="font-semibold text-red-800 dark:text-red-200">Something went wrong</h2>
      <p className="mt-1 text-sm text-red-700 dark:text-red-300">We could not load this page. Please try again.</p>
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={() => retry()} className={buttonClass.primary}>
          Try again
        </button>
        <Link href="/dashboard" className={buttonClass.secondary}>
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
