import Link from "next/link";

import { buttonClass } from "../_components/ui";

export default function NotFound() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-950">
      <h2 className="font-semibold">Not found</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        This page does not exist or you do not have access to it.
      </p>
      <Link href="/dashboard" className={`${buttonClass.secondary} mt-4`}>
        Back to dashboard
      </Link>
    </div>
  );
}
