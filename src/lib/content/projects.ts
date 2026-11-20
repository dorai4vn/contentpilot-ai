import "server-only";

import {
  projectCreateSchema,
  projectListSchema,
  projectRefSchema,
  projectUpdateSchema,
} from "@/lib/validation/content";

import { contentClient } from "./client";
import { ContentError, parseContentInput, toContentError } from "./errors";

/**
 * Content projects. Every query runs as the signed-in user, so RLS decides what is
 * visible and who may write (owners/admins create, rename and archive projects).
 * There is deliberately no delete function: M2 only archives.
 */

const PROJECT_COLUMNS = "id, workspace_id, name, description, created_by, archived_at, created_at, updated_at";

type ProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ContentProject = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toProject(row: ProjectRow): ContentProject {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type Supabase = Awaited<ReturnType<typeof contentClient>>["supabase"];

/**
 * An UPDATE that matched no row is silent under RLS. Work out why, without
 * revealing anything the user may not see: invisible -> not_found, archived ->
 * archived (when relevant), otherwise the user lacks the owner/admin role.
 */
async function explainNoProjectRow(
  supabase: Supabase,
  projectId: string,
  { checkArchived }: { checkArchived: boolean },
): Promise<ContentError> {
  const { data, error } = await supabase
    .from("content_projects")
    .select("archived_at")
    .eq("id", projectId)
    .maybeSingle();
  if (error) return toContentError(error);
  if (!data) return new ContentError("not_found");
  if (checkArchived && data.archived_at) return new ContentError("archived");
  return new ContentError("forbidden");
}

/** Projects of a workspace (active only unless includeArchived), oldest first. */
export async function listProjects(input: unknown): Promise<ContentProject[]> {
  const { workspaceId, includeArchived } = parseContentInput(projectListSchema, input);
  const { supabase } = await contentClient();

  let query = supabase.from("content_projects").select(PROJECT_COLUMNS).eq("workspace_id", workspaceId);
  if (!includeArchived) query = query.is("archived_at", null);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(200);

  if (error) throw toContentError(error);
  return (data ?? []).map(toProject);
}

/** One project, or null when it does not exist or is not visible to the user. */
export async function getProject(input: unknown): Promise<ContentProject | null> {
  const { projectId } = parseContentInput(projectRefSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase
    .from("content_projects")
    .select(PROJECT_COLUMNS)
    .eq("id", projectId)
    .maybeSingle();

  if (error) throw toContentError(error);
  return data ? toProject(data) : null;
}

/** Creates a project (owners/admins only, enforced by RLS). */
export async function createProject(input: unknown): Promise<ContentProject> {
  const { workspaceId, name, description } = parseContentInput(projectCreateSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase
    .from("content_projects")
    .insert({ id: crypto.randomUUID(), workspace_id: workspaceId, name, description })
    .select(PROJECT_COLUMNS)
    .single();

  if (error) throw toContentError(error);
  return toProject(data);
}

/** Renames / re-describes an active project (owners/admins only). */
export async function updateProject(input: unknown): Promise<ContentProject> {
  const { projectId, name, description } = parseContentInput(projectUpdateSchema, input);
  const { supabase } = await contentClient();

  const { data, error } = await supabase
    .from("content_projects")
    .update({ name, description })
    .eq("id", projectId)
    .is("archived_at", null)
    .select(PROJECT_COLUMNS)
    .maybeSingle();

  if (error) throw toContentError(error);
  if (!data) throw await explainNoProjectRow(supabase, projectId, { checkArchived: true });
  return toProject(data);
}

async function setProjectArchived(input: unknown, archived: boolean): Promise<ContentProject> {
  const { projectId } = parseContentInput(projectRefSchema, input);
  const { supabase } = await contentClient();

  // The database stamps archived_at with its own clock (and keeps the first one
  // if the project is already archived), so the value sent here is only a marker.
  const { data, error } = await supabase
    .from("content_projects")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", projectId)
    .select(PROJECT_COLUMNS)
    .maybeSingle();

  if (error) throw toContentError(error);
  if (!data) throw await explainNoProjectRow(supabase, projectId, { checkArchived: false });
  return toProject(data);
}

/** Archives a project (owners/admins). Idempotent. Its posts become read-only. */
export function archiveProject(input: unknown): Promise<ContentProject> {
  return setProjectArchived(input, true);
}

/** Restores an archived project (owners/admins). Idempotent. */
export function restoreProject(input: unknown): Promise<ContentProject> {
  return setProjectArchived(input, false);
}
