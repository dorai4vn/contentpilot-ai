"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";

import { buttonClass } from "../_components/ui";

/** Unexpected failure while loading content. Details stay in the server logs. */
export default function ContentError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-white p-6 shadow-card">
      <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600 ring-1 ring-red-100">
        <AlertTriangle className="h-5 w-5" aria-hidden />
      </span>
      <h2 className="font-semibold text-slate-900">Đã có lỗi xảy ra</h2>
      <p className="mt-1 text-sm text-slate-600">Không thể tải trang này. Vui lòng thử lại.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => retry()} className={buttonClass.primary}>
          Thử lại
        </button>
        <Link href="/dashboard" className={buttonClass.secondary}>
          Về bảng điều khiển
        </Link>
      </div>
    </div>
  );
}
