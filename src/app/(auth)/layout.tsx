import { Bot, ClipboardCheck, History, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { BrandMark } from "@/app/_components/app-header";

/** What the product really does (no marketing numbers, no stock images). */
const FEATURES = [
  { icon: Bot, title: "Trợ lý AI trên dữ liệu thật", text: "Đọc dự án, tạo và chỉnh sửa bản nháp ngay trong không gian của bạn." },
  { icon: ClipboardCheck, title: "Con người phê duyệt", text: "Mọi bài viết chỉ được xuất bản sau khi chủ sở hữu hoặc quản trị viên duyệt." },
  { icon: ShieldCheck, title: "Tách biệt theo không gian", text: "Row Level Security: bạn chỉ thấy dữ liệu của không gian mình tham gia." },
  { icon: History, title: "Lịch sử và nhật ký đầy đủ", text: "Mỗi phiên bản bài viết và mỗi thao tác của AI đều được ghi lại." },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="grid flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className="relative hidden overflow-hidden border-r border-slate-200 bg-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_-10%_-10%,rgb(79_70_229/0.10),transparent_60%)]"
          aria-hidden
        />
        <Link href="/" className="relative w-fit rounded-lg">
          <BrandMark className="text-lg" />
        </Link>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight text-slate-900">
            Quản lý nội dung cùng trợ lý AI — an toàn, có kiểm soát.
          </h2>
          <ul className="mt-8 space-y-5">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3">
                <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-900">{title}</span>
                  <span className="block text-sm text-slate-600">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-slate-400">Ứng dụng học thuật · Next.js · Supabase · OpenAI</p>
      </section>

      <section className="flex items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-sm">
          <Link href="/" className="mb-8 flex justify-center rounded-lg lg:hidden">
            <BrandMark className="text-lg" />
          </Link>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-raised sm:p-8">{children}</div>
        </div>
      </section>
    </main>
  );
}
