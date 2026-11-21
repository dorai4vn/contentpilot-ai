import { ArrowRight, Building2, Crown, LayoutGrid, Plus, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AppHeader } from "@/app/_components/app-header";
import { LocalDateTime } from "@/app/w/_components/client-ui";
import { Badge, Card, EmptyState, PageHeader, StatCard } from "@/app/w/_components/ui";
import { requireUser } from "@/lib/auth/dal";
import { ROLE_LABELS } from "@/lib/workspaces/labels";
import { listMyWorkspaces } from "@/lib/workspaces/queries";

import { CreateWorkspaceForm } from "./create-workspace-form";

export const metadata: Metadata = { title: "Bảng điều khiển" };

export default async function DashboardPage() {
  // Server-side protection: the proxy redirect is only an optimisation.
  const user = await requireUser("/dashboard");
  const workspaces = await listMyWorkspaces(user);
  const owned = workspaces.filter((ws) => ws.role === "owner").length;
  const managed = workspaces.filter((ws) => ws.role === "owner" || ws.role === "admin").length;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader email={user.email} />

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-8 sm:px-6">
        <PageHeader
          icon={LayoutGrid}
          title="Bảng điều khiển"
          description={
            <>
              Đang đăng nhập với <span className="font-medium text-slate-900">{user.email}</span>
            </>
          }
        />

        <section aria-label="Số liệu" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard label="Không gian làm việc" value={workspaces.length} icon={Building2} tone="indigo" hint="Bạn là thành viên" />
          <StatCard label="Bạn sở hữu" value={owned} icon={Crown} tone="amber" hint="Vai trò Chủ sở hữu" />
          <StatCard
            label="Bạn có quyền duyệt"
            value={managed}
            icon={ShieldCheck}
            tone="emerald"
            hint="Chủ sở hữu hoặc quản trị viên"
          />
        </section>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
            <div className="border-b border-slate-100 px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">Không gian làm việc của bạn</h2>
              <p className="mt-0.5 text-sm text-slate-600">
                Dữ liệu được lưu trong PostgreSQL và bảo vệ bằng Row Level Security: bạn chỉ thấy những không gian mình là
                thành viên.
              </p>
            </div>

            {workspaces.length === 0 ? (
              <div className="p-5">
                <EmptyState title="Bạn chưa có không gian làm việc nào" icon={Building2}>
                  Hãy tạo không gian đầu tiên ở khung bên cạnh.
                </EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-slate-100" data-testid="workspace-list">
                {workspaces.map((ws) => (
                  <li key={ws.id} className="flex items-center justify-between gap-4 px-5 py-3.5 transition hover:bg-slate-50">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-sm font-semibold text-indigo-700 ring-1 ring-indigo-100"
                        aria-hidden
                      >
                        {ws.name.trim().charAt(0).toUpperCase() || "W"}
                      </span>
                      <div className="min-w-0">
                        <Link
                          href={`/w/${ws.id}`}
                          className="block truncate font-medium text-slate-900 hover:text-indigo-600"
                          data-testid="workspace-link"
                        >
                          {ws.name}
                        </Link>
                        <p className="text-xs text-slate-500">
                          Tạo ngày <LocalDateTime iso={ws.createdAt} dateOnly />
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Badge tone={ws.role === "member" ? "neutral" : "indigo"}>{ROLE_LABELS[ws.role]}</Badge>
                      <Link
                        href={`/w/${ws.id}`}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-xs hover:bg-slate-50 hover:text-slate-900"
                      >
                        Mở
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Card>
            <h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-slate-900">
              <Plus className="h-4 w-4 text-indigo-600" aria-hidden />
              Tạo không gian mới
            </h2>
            <p className="mb-4 text-sm text-slate-600">Bạn sẽ là chủ sở hữu và có thể mời thành viên sau.</p>
            <CreateWorkspaceForm />
          </Card>
        </div>
      </main>
    </div>
  );
}
