import { Activity, ArrowRight, Bot, ClipboardCheck, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { BrandMark } from "@/app/_components/app-header";
import { getCurrentUser } from "@/lib/auth/dal";
import { readSupabaseEnv } from "@/lib/env";

const HIGHLIGHTS = [
  { icon: Bot, title: "Trợ lý AI", text: "Đọc, tạo và chỉnh sửa bản nháp trên dữ liệu thật của bạn." },
  { icon: ClipboardCheck, title: "Phê duyệt bởi con người", text: "Không bài viết nào được xuất bản khi chưa được duyệt." },
  { icon: ShieldCheck, title: "Bảo mật theo không gian", text: "Row Level Security tách biệt dữ liệu từng không gian." },
];

export default async function Home() {
  const configured = readSupabaseEnv() !== null;
  const user = await getCurrentUser();

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[32rem] bg-[radial-gradient(50rem_24rem_at_50%_-10%,rgb(79_70_229/0.12),transparent_70%)]"
        aria-hidden
      />
      <div className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-10 px-4 py-16 sm:px-6">
        <BrandMark className="text-lg" />
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
            Không gian nội dung có trợ lý AI
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">ContentPilot AI</h1>
          <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-600">
            Lên kế hoạch, soạn thảo và quản lý nội dung cùng trợ lý AI làm việc trên dữ liệu thật của bạn — mọi thao
            tác rủi ro đều cần con người phê duyệt.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {user ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 font-medium text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-500"
            >
              Vào bảng điều khiển
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 font-medium text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-500"
              >
                Đăng nhập
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link
                href="/signup"
                className="rounded-lg border border-slate-200 bg-white px-5 py-2.5 font-medium text-slate-700 shadow-xs hover:bg-slate-50 hover:text-slate-900"
              >
                Tạo tài khoản
              </Link>
            </>
          )}
          <a
            href="/api/health"
            className="inline-flex items-center gap-1.5 px-2 py-2.5 text-sm text-slate-500 underline-offset-4 hover:text-slate-700 hover:underline"
          >
            <Activity className="h-4 w-4" aria-hidden />
            Trạng thái hệ thống
          </a>
        </div>

        <ul className="grid gap-3 sm:grid-cols-3">
          {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <p className="mt-3 text-sm font-semibold text-slate-900">{title}</p>
              <p className="mt-1 text-sm text-slate-600">{text}</p>
            </li>
          ))}
        </ul>

        {!configured ? (
          <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Bản triển khai này chưa kết nối Supabase. Hãy thiết lập các biến môi trường được liệt kê trong{" "}
            <code>.env.example</code>.
          </p>
        ) : null}
      </div>
    </main>
  );
}
