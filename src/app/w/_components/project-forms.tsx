"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";

import {
  archiveProjectAction,
  createProjectAction,
  type ProjectActionData,
  restoreProjectAction,
  updateProjectAction,
} from "@/app/_actions/content/projects";
import type { ActionState } from "@/app/_actions/content/action-result";
import { CONTENT_LIMITS } from "@/lib/validation/content";

import { ActionFeedback, LocalDateTime, SubmitButton } from "./client-ui";
import { Badge, FieldError, FieldLabel, buttonClass, inputClass } from "./ui";

export type ProjectView = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  updatedAt: string;
};

type State = ActionState<ProjectActionData>;

/** New project form. Rendered only for owners/admins (RLS enforces it anyway). */
export function CreateProjectForm({ workspaceId }: { workspaceId: string }) {
  const [state, action] = useActionState<State, FormData>(createProjectAction, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const errors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form ref={formRef} action={action} className="space-y-3" data-testid="create-project-form">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <div>
          <FieldLabel htmlFor="new-project-name">Tên dự án</FieldLabel>
          <input
            id="new-project-name"
            name="name"
            required
            maxLength={CONTENT_LIMITS.projectNameMax}
            placeholder="Ví dụ: Blog công ty"
            className={inputClass}
          />
          <FieldError message={errors?.name} />
        </div>
        <div>
          <FieldLabel htmlFor="new-project-description">Mô tả (không bắt buộc)</FieldLabel>
          <input
            id="new-project-description"
            name="description"
            maxLength={CONTENT_LIMITS.projectDescriptionMax}
            placeholder="Dự án này dùng để làm gì?"
            className={inputClass}
          />
          <FieldError message={errors?.description} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Đang tạo…" testId="create-project-submit">
          Tạo dự án
        </SubmitButton>
        <ActionFeedback state={state} success="Đã tạo dự án." testId="create-project" />
      </div>
    </form>
  );
}

function ArchiveToggle({ project }: { project: ProjectView }) {
  const archived = project.archivedAt !== null;
  const [state, action] = useActionState<State, FormData>(
    archived ? restoreProjectAction : archiveProjectAction,
    null,
  );
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="projectId" value={project.id} />
      <SubmitButton
        variant={archived ? "secondary" : "ghost"}
        pendingLabel={archived ? "Đang khôi phục…" : "Đang lưu trữ…"}
        testId={archived ? "restore-project" : "archive-project"}
      >
        {archived ? "Khôi phục" : "Lưu trữ"}
      </SubmitButton>
      {state && !state.ok ? <ActionFeedback state={state} testId="archive-project" /> : null}
    </form>
  );
}

function EditProjectForm({ project, onDone }: { project: ProjectView; onDone: () => void }) {
  const [state, action] = useActionState<State, FormData>(updateProjectAction, null);

  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form action={action} className="space-y-3" data-testid="edit-project-form">
      <input type="hidden" name="projectId" value={project.id} />
      <div>
        <FieldLabel htmlFor={`name-${project.id}`}>Tên dự án</FieldLabel>
        <input
          id={`name-${project.id}`}
          name="name"
          required
          maxLength={CONTENT_LIMITS.projectNameMax}
          defaultValue={project.name}
          className={inputClass}
        />
        <FieldError message={errors?.name} />
      </div>
      <div>
        <FieldLabel htmlFor={`description-${project.id}`}>Mô tả</FieldLabel>
        <textarea
          id={`description-${project.id}`}
          name="description"
          rows={2}
          maxLength={CONTENT_LIMITS.projectDescriptionMax}
          defaultValue={project.description ?? ""}
          className={inputClass}
        />
        <FieldError message={errors?.description} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pendingLabel="Đang lưu…" testId="save-project">
          Lưu
        </SubmitButton>
        <button type="button" className={buttonClass.ghost} onClick={onDone}>
          Hủy
        </button>
        <ActionFeedback state={state} testId="edit-project" />
      </div>
    </form>
  );
}

/** One project row. Management controls only for owners/admins. */
export function ProjectCard({ project, canManage }: { project: ProjectView; canManage: boolean }) {
  const [editing, setEditing] = useState(false);
  const archived = project.archivedAt !== null;
  const href = `/w/${project.workspaceId}/p/${project.id}`;

  return (
    <li className="py-4" data-testid="project-item">
      {editing && canManage && !archived ? (
        <EditProjectForm project={project} onDone={() => setEditing(false)} />
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href={href} className="truncate font-medium hover:text-indigo-600 hover:underline" data-testid="project-link">
                {project.name}
              </Link>
              {archived ? <Badge tone="amber">Đã lưu trữ</Badge> : null}
            </div>
            {project.description ? (
              <p className="mt-0.5 line-clamp-2 text-sm text-slate-600 dark:text-slate-400">{project.description}</p>
            ) : null}
            <p className="mt-0.5 text-xs text-slate-500">
              Cập nhật lúc <LocalDateTime iso={project.updatedAt} />
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link href={href} className={buttonClass.secondary}>
              Mở
            </Link>
            {canManage && !archived ? (
              <button type="button" className={buttonClass.ghost} onClick={() => setEditing(true)} data-testid="edit-project">
                Sửa
              </button>
            ) : null}
            {canManage ? <ArchiveToggle key={project.archivedAt ?? "active"} project={project} /> : null}
          </div>
        </div>
      )}
    </li>
  );
}
