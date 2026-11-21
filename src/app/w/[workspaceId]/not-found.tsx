import { SearchX } from "lucide-react";
import Link from "next/link";

import { buttonClass } from "../_components/ui";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center rounded-xl border border-slate-200 bg-white p-8 text-center shadow-card">
      <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <SearchX className="h-5 w-5" aria-hidden />
      </span>
      <h2 className="font-semibold text-slate-900">Không tìm thấy</h2>
      <p className="mt-1 text-sm text-slate-600">
        Trang này không tồn tại hoặc bạn không có quyền truy cập.
      </p>
      <Link href="/dashboard" className={`${buttonClass.secondary} mt-4`}>
        Về bảng điều khiển
      </Link>
    </div>
  );
}
