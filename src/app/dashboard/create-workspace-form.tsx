"use client";

import { useActionState, useEffect, useRef } from "react";

import { buttonClass, inputClass } from "@/app/w/_components/ui";

import { createWorkspaceAction, type CreateWorkspaceState } from "./actions";

export function CreateWorkspaceForm() {
  const [state, formAction, pending] = useActionState<CreateWorkspaceState, FormData>(createWorkspaceAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-2">
      <label className="flex-1">
        <span className="sr-only">Tên không gian làm việc</span>
        <input
          name="name"
          required
          maxLength={100}
          placeholder="Tên không gian làm việc mới"
          className={inputClass}
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
        className={`${buttonClass.primary} w-full`}
      >
        {pending ? "Đang tạo…" : "Tạo không gian làm việc"}
      </button>
    </form>
  );
}
