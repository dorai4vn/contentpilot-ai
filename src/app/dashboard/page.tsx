import type { Metadata } from "next";

import Link from "next/link";

import { AppHeader } from "@/app/_components/app-header";
import { requireUser } from "@/lib/auth/dal";
import { listMyWorkspaces } from "@/lib/workspaces/queries";

import { CreateWorkspaceForm } from "./create-workspace-form";

export const metadata: Metadata = { title: "Dashboard" };

const roleLabel = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export default async function DashboardPage() {
  // Server-side protection: the proxy redirect is only an optimisation.
  const user = await requireUser("/dashboard");
  const workspaces = await listMyWorkspaces(user);

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader email={user.email} />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Signed in as <span className="font-medium">{user.email}</span>
        </p>

        <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-950">
          <h2 className="text-lg font-semibold">Your workspaces</h2>
          <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
            Workspaces are stored in PostgreSQL and protected by Row Level Security: you only see the ones you belong to.
          </p>

          <CreateWorkspaceForm />

          {workspaces.length === 0 ? (
            <p className="mt-6 text-sm text-slate-500">No workspaces yet. Create your first one above.</p>
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
                      Created {new Date(ws.createdAt).toLocaleDateString("en-GB", { dateStyle: "medium" })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                      {roleLabel[ws.role]}
                    </span>
                    <Link
                      href={`/w/${ws.id}`}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      Open
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
