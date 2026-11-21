"use client";

/** App-wide fallback for unexpected errors. Details stay in the server logs. */
export default function AppError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div role="alert" className="w-full max-w-md rounded-2xl border border-red-200 bg-white p-8 text-center shadow-raised">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Đã có lỗi xảy ra</h1>
        <p className="mt-1 text-sm text-slate-600">Không thể tải trang này. Vui lòng thử lại.</p>
        <button
          type="button"
          onClick={() => retry()}
          className="mt-5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-500"
        >
          Thử lại
        </button>
      </div>
    </main>
  );
}
