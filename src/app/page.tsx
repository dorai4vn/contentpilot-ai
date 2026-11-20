import Link from "next/link";

import { getCurrentUser } from "@/lib/auth/dal";
import { readSupabaseEnv } from "@/lib/env";

export default async function Home() {
  const configured = readSupabaseEnv() !== null;
  const user = await getCurrentUser();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-4 py-16">
      <div>
        <p className="text-sm font-medium uppercase tracking-widest text-indigo-600">Agentic content workspace</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">ContentPilot AI</h1>
        <p className="mt-4 max-w-xl text-lg text-slate-600 dark:text-slate-400">
          Plan, draft and manage content with an AI agent that works on your real workspace data — with a human in the
          loop for anything risky.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        {user ? (
          <Link href="/dashboard" className="rounded-md bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-500">
            Go to dashboard
          </Link>
        ) : (
          <>
            <Link href="/login" className="rounded-md bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-500">
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-md border border-slate-300 px-5 py-2.5 font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Create account
            </Link>
          </>
        )}
        <a href="/api/health" className="px-2 py-2.5 text-sm text-slate-500 underline-offset-4 hover:underline">
          System health
        </a>
      </div>

      {!configured ? (
        <p role="alert" className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          This deployment is not connected to Supabase yet. Set the environment variables listed in{" "}
          <code>.env.example</code>.
        </p>
      ) : null}
    </main>
  );
}
