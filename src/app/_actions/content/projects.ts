"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/dal";
import { contentPaths } from "@/lib/content/paths";
import {
  archiveProject,
  createProject,
  type ContentProject,
  restoreProject,
  updateProject,
} from "@/lib/content/projects";
import { projectCreateSchema, projectRefSchema, projectUpdateSchema } from "@/lib/validation/content";

import { type ActionResult, type ActionState, parseForm, runAction } from "./action-result";

/**
 * Server Actions for content projects. Server Actions are public endpoints, so
 * each one re-verifies the session, validates the form with zod and calls the
 * data layer, which runs as the user under RLS (only owners/admins may write).
 */

export type ProjectActionData = { projectId: string; workspaceId: string; archived: boolean };

function done(project: ContentProject): ProjectActionData {
  revalidatePath(contentPaths.workspace(project.workspaceId));
  revalidatePath(contentPaths.project(project.workspaceId, project.id));
  return { projectId: project.id, workspaceId: project.workspaceId, archived: project.archivedAt !== null };
}

/** Fields: workspaceId, name, description? */
export async function createProjectAction(
  _prev: ActionState<ProjectActionData>,
  formData: FormData,
): Promise<ActionResult<ProjectActionData>> {
  await requireUser();
  const input = parseForm(projectCreateSchema, formData);
  if (!input.ok) return input.result;
  return runAction(() => createProject(input.data), done);
}

/** Fields: projectId, name, description? */
export async function updateProjectAction(
  _prev: ActionState<ProjectActionData>,
  formData: FormData,
): Promise<ActionResult<ProjectActionData>> {
  await requireUser();
  const input = parseForm(projectUpdateSchema, formData);
  if (!input.ok) return input.result;
  return runAction(() => updateProject(input.data), done);
}

/** Fields: projectId */
export async function archiveProjectAction(
  _prev: ActionState<ProjectActionData>,
  formData: FormData,
): Promise<ActionResult<ProjectActionData>> {
  await requireUser();
  const input = parseForm(projectRefSchema, formData);
  if (!input.ok) return input.result;
  return runAction(() => archiveProject(input.data), done);
}

/** Fields: projectId */
export async function restoreProjectAction(
  _prev: ActionState<ProjectActionData>,
  formData: FormData,
): Promise<ActionResult<ProjectActionData>> {
  await requireUser();
  const input = parseForm(projectRefSchema, formData);
  if (!input.ok) return input.result;
  return runAction(() => restoreProject(input.data), done);
}
