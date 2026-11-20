"use client";

/** App-wide fallback for unexpected errors. Details stay in the server logs. */
export default function AppError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div role="alert" className="max-w-md rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950">
        <h1 className="text-lg font-semibold text-red-800 dark:text-red-200">Đã có lỗi xảy ra</h1>
        <p className="mt-1 text-sm text-red-700 dark:text-red-300">Không thể tải trang này. Vui lòng thử lại.</p>
        <button
          type="button"
          onClick={() => retry()}
          className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Thử lại
        </button>
      </div>
    </main>
  );
}
