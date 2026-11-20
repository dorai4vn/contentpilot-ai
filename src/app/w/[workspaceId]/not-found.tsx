import Link from "next/link";

import { buttonClass } from "../_components/ui";

export default function NotFound() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-950">
      <h2 className="font-semibold">Không tìm thấy</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Trang này không tồn tại hoặc bạn không có quyền truy cập.
      </p>
      <Link href="/dashboard" className={`${buttonClass.secondary} mt-4`}>
        Về bảng điều khiển
      </Link>
    </div>
  );
}
