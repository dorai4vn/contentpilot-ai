"use client";

import { useActionState, useState } from "react";

import { buttonClass, inputClass } from "@/app/w/_components/ui";

import { renameWorkspaceAction, type RenameWorkspaceState } from "./actions";

export function RenameWorkspaceForm({ workspaceId, currentName, canEdit }: {
  workspaceId: string;
  currentName: string;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<RenameWorkspaceState, FormData>(
    async (prev, formData) => {
      const result = await renameWorkspaceAction(workspaceId, prev, formData);
      if (result.ok) setEditing(false);
      return result;
    },
    {},
  );

  if (!editing) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500">Tên không gian làm việc</p>
          <p className="truncate text-base font-semibold text-slate-900" data-testid="workspace-name">{currentName}</p>
          {state.ok ? <p role="status" className="mt-1 text-xs text-emerald-700">Đã lưu tên mới.</p> : null}
          {!canEdit ? (
            <p className="mt-1 text-xs text-slate-500">Chỉ Chủ sở hữu hoặc Quản trị viên mới được đổi tên.</p>
          ) : null}
        </div>
        {canEdit ? (
          <button type="button" className={buttonClass.secondary} data-testid="workspace-rename-edit" onClick={() => setEditing(true)}>
            Sửa
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3" data-testid="workspace-rename-form">
      <label className="block">
        <span className="text-xs font-medium text-slate-500">Tên không gian làm việc</span>
        <input
          name="name"
          required
          maxLength={100}
          autoFocus
          defaultValue={currentName}
          disabled={pending}
          aria-invalid={state.error ? true : undefined}
          className={`${inputClass} mt-1`}
        />
      </label>
      {state.error ? (
        <p role="alert" className="text-xs text-red-600" data-testid="workspace-rename-error">{state.error}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={buttonClass.primary}>
          {pending ? "Đang lưu…" : "Lưu"}
        </button>
        <button type="button" disabled={pending} className={buttonClass.secondary} onClick={() => setEditing(false)}>
          Hủy
        </button>
      </div>
    </form>
  );
}
