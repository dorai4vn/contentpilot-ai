import type { Metadata } from "next";

import Link from "next/link";

import { AppHeader } from "@/app/_components/app-header";
import { LocalDateTime } from "@/app/w/_components/client-ui";
import { requireUser } from "@/lib/auth/dal";
import { ROLE_LABELS } from "@/lib/workspaces/labels";
import { listMyWorkspaces } from "@/lib/workspaces/queries";

import { CreateWorkspaceForm } from "./create-workspace-form";

export const metadata: Metadata = { title: "Bảng điều khiển" };

export default async function DashboardPage() {
  // Server-side protection: the proxy redirect is only an optimisation.
  const user = await requireUser("/dashboard");
  const workspaces = await listMyWorkspaces(user);

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader email={user.email} />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Bảng điều khiển</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Đang đăng nhập với <span className="font-medium">{user.email}</span>
        </p>

        <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-950">
          <h2 className="text-lg font-semibold">Không gian làm việc của bạn</h2>
          <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
            Dữ liệu được lưu trong PostgreSQL và bảo vệ bằng Row Level Security: bạn chỉ thấy những không gian mình là thành viên.
          </p>

          <CreateWorkspaceForm />

          {workspaces.length === 0 ? (
            <p className="mt-6 text-sm text-slate-500">Bạn chưa có không gian làm việc nào. Hãy tạo không gian đầu tiên ở trên.</p>
          ) : (
            <ul className="mt-6 divide-y divide-slate-200 dark:divide-slate-800" data-testid="workspace-list">
              {workspaces.map((ws) => (
                <li key={ws.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/w/${ws.id}`}
                      className="truncate font-medium hover:text-indigo-600 hover:underline"
                      data-testid="workspace-link"
                    >
                      {ws.name}
                    </Link>
                    <p className="text-xs text-slate-500">
                      Tạo ngày <LocalDateTime iso={ws.createdAt} dateOnly />
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                      {ROLE_LABELS[ws.role]}
                    </span>
                    <Link
                      href={`/w/${ws.id}`}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      Mở
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
