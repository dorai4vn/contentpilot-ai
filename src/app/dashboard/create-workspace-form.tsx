"use client";

import { useActionState, useEffect, useRef } from "react";

import { createWorkspaceAction, type CreateWorkspaceState } from "./actions";

export function CreateWorkspaceForm() {
  const [state, formAction, pending] = useActionState<CreateWorkspaceState, FormData>(createWorkspaceAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <label className="flex-1">
        <span className="sr-only">Workspace name</span>
        <input
          name="name"
          required
          maxLength={100}
          placeholder="New workspace name"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        {state.error ? (
          <span role="alert" className="mt-1 block text-xs text-red-600">
            {state.error}
          </span>
        ) : null}
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}
