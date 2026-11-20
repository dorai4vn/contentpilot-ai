import Link from "next/link";

/** App-wide 404 (also used when a content layout calls notFound()). */
export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-950">
        <p className="text-sm font-medium text-indigo-600">404</p>
        <h1 className="mt-1 text-lg font-semibold">Không tìm thấy trang</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Trang này không tồn tại hoặc bạn không có quyền truy cập.
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-flex rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Về bảng điều khiển
        </Link>
      </div>
    </main>
  );
}
