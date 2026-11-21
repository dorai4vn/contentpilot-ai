import Link from "next/link";

/** App-wide 404 (also used when a content layout calls notFound()). */
export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-raised">
        <p className="text-sm font-semibold text-indigo-600">404</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">Không tìm thấy trang</h1>
        <p className="mt-1 text-sm text-slate-600">
          Trang này không tồn tại hoặc bạn không có quyền truy cập.
        </p>
        <Link
          href="/dashboard"
          className="mt-5 inline-flex rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-xs hover:bg-slate-50 hover:text-slate-900"
        >
          Về bảng điều khiển
        </Link>
      </div>
    </main>
  );
}
