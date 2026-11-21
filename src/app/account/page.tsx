import type { Metadata } from "next";

import { AppHeader } from "@/app/_components/app-header";
import { Breadcrumbs, Card, Notice } from "@/app/w/_components/ui";
import { requireUser } from "@/lib/auth/dal";
import { getMyProfile } from "@/lib/profiles/profiles";

import { ProfileForm } from "./profile-form";

export const metadata: Metadata = { title: "Tài khoản" };

export default async function AccountPage() {
  const user = await requireUser("/account");
  const profile = await getMyProfile();

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader email={user.email} />
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 py-8">
        <div>
          <Breadcrumbs items={[{ label: "Bảng điều khiển", href: "/dashboard" }, { label: "Tài khoản" }]} />
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="account-title">
            Tài khoản
          </h1>
        </div>
        <Card className="max-w-xl">
          <h2 className="mb-1 font-semibold">Tên hiển thị</h2>
          <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
            Tên này hiện trong lịch sử phê duyệt cho các thành viên cùng không gian làm việc với bạn. Email của bạn
            không bao giờ được hiển thị cho người khác.
          </p>
          {profile ? null : (
            <div className="mb-4">
              <Notice tone="info" testId="profile-missing">
                Bạn chưa đặt tên hiển thị. Hiện người khác chỉ thấy vai trò của bạn (ví dụ: Thành viên).
              </Notice>
            </div>
          )}
          {/* Not keyed by updatedAt: the form must survive the refresh after a save, or
              its success message would disappear (the input already shows the new name). */}
          <ProfileForm displayName={profile?.displayName ?? null} />
        </Card>
      </main>
    </div>
  );
}
