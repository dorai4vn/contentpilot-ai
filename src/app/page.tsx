import { Activity, ArrowRight, Bot, ClipboardCheck, Newspaper } from "lucide-react";
import Link from "next/link";

import { BrandMark } from "@/app/_components/app-header";
import { getCurrentUser } from "@/lib/auth/dal";
import { readSupabaseEnv } from "@/lib/env";

const HIGHLIGHTS = [
  { icon: Newspaper, title: "Luồng tin bóng đá", text: "Theo dõi tin RSS và mức độ đáng chú ý từ các nguồn thể thao." },
  { icon: ClipboardCheck, title: "Hàng chờ duyệt", text: "Xem và duyệt bản nháp khi chế độ duyệt thủ công đang hoạt động." },
  { icon: Bot, title: "Content Studio", text: "Quản lý bài viết và làm việc cùng trợ lý AI trong cùng không gian." },
];

export default async function Home() {
  const configured = readSupabaseEnv() !== null;
  const user = await getCurrentUser();

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <div className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-10 px-4 py-16 sm:px-6">
        <BrandMark className="text-lg" />
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800">
            Luồng vận hành tin bóng đá
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">Social Automation</h1>
          <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-600">
            Theo dõi tin bóng đá từ RSS, xem bài chờ duyệt và quản lý nội dung xuất bản trong một không gian làm việc.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {user ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-5 py-2.5 font-medium text-white hover:bg-emerald-800"
            >
              Vào bảng điều khiển
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-5 py-2.5 font-medium text-white hover:bg-emerald-800"
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
