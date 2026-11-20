"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import type { ActionResult, ActionState } from "@/app/_actions/content/action-result";
import {
  archivePostAction,
  createPostAction,
  type PostActionData,
  restorePostAction,
  setPostStatusAction,
  updatePostAction,
} from "@/app/_actions/content/posts";
import { contentPaths } from "@/lib/content/paths";
import { CONTENT_LIMITS } from "@/lib/validation/content";
import type { ContentPostStatus } from "@/types/database";

import { ActionFeedback, SubmitButton } from "./client-ui";
import { ScheduleField } from "./schedule-field";
import { FieldError, FieldLabel, Notice, buttonClass, inputClass } from "./ui";

type State = ActionState<PostActionData>;

/** The fields of a post the editor needs (serialisable props from the server page). */
export type EditablePost = {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  body: string;
  status: ContentPostStatus;
  scheduledFor: string | null;
  version: number;
  archivedAt: string | null;
};

function StatusSelect({ id, defaultValue }: { id: string; defaultValue: "draft" | "ready" }) {
  return (
    <select id={id} name="status" defaultValue={defaultValue} className={inputClass} data-testid="status-select">
      <option value="draft">Draft</option>
      <option value="ready">Ready</option>
    </select>
  );
}

/** New post in an active project; opens the editor once created. */
export function CreatePostForm({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const [state, action] = useActionState<State, FormData>(createPostAction, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) router.push(contentPaths.post(state.data.workspaceId, state.data.postId));
  }, [state, router]);

  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form action={action} className="space-y-3" data-testid="create-post-form">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="projectId" value={projectId} />
      <div>
        <FieldLabel htmlFor="new-post-title">Title</FieldLabel>
        <input
          id="new-post-title"
          name="title"
          required
          maxLength={CONTENT_LIMITS.postTitleMax}
          placeholder="Post title"
          className={inputClass}
        />
        <FieldError message={errors?.title} />
      </div>
      <div>
        <FieldLabel htmlFor="new-post-body">Content</FieldLabel>
        <textarea id="new-post-body" name="body" rows={4} maxLength={CONTENT_LIMITS.postBodyMax} className={inputClass} />
        <FieldError message={errors?.body} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor="new-post-status">Status</FieldLabel>
          <StatusSelect id="new-post-status" defaultValue="draft" />
        </div>
        <div>
          <FieldLabel htmlFor="new-post-schedule">Planned publication</FieldLabel>
          <ScheduleField id="new-post-schedule" initialIso={null} error={errors?.scheduledFor} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Creating…" testId="create-post-submit">
          Create post
        </SubmitButton>
        <ActionFeedback state={state} success="Post created. Opening the editor…" testId="create-post" />
      </div>
    </form>
  );
}

type ConflictSnapshot = { title: string; body: string };

/**
 * Edit form for title, body and schedule. The page keys it by post version, so it
 * re-mounts with fresh values whenever the server version changes. It always sends
 * the version it was rendered with (expectedVersion) and the current status, so a
 * concurrent change is rejected instead of overwritten.
 */
function EditForm({
  post,
  readOnly,
  onConflict,
  onSaved,
}: {
  post: EditablePost;
  readOnly: boolean;
  onConflict: (snapshot: ConflictSnapshot) => void;
  onSaved: (version: number) => void;
}) {
  const [state, action] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await updatePostAction(prev, formData);
    if (result.ok) onSaved(result.data.version);
    else if (result.code === "version_conflict") {
      onConflict({ title: String(formData.get("title") ?? ""), body: String(formData.get("body") ?? "") });
    }
    return result;
  }, null);

  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form action={action} className="space-y-4" data-testid="post-editor-form">
      <input type="hidden" name="postId" value={post.id} />
      <input type="hidden" name="expectedVersion" value={post.version} data-testid="expected-version" />
      <input type="hidden" name="status" value={post.status} />
      <div>
        <FieldLabel htmlFor="post-title">Title</FieldLabel>
        <input
          id="post-title"
          name="title"
          required
          maxLength={CONTENT_LIMITS.postTitleMax}
          defaultValue={post.title}
          disabled={readOnly}
          className={inputClass}
        />
        <FieldError message={errors?.title} />
      </div>
      <div>
        <FieldLabel htmlFor="post-body">Content</FieldLabel>
        <textarea
          id="post-body"
          name="body"
          rows={14}
          maxLength={CONTENT_LIMITS.postBodyMax}
          defaultValue={post.body}
          disabled={readOnly}
          className={`${inputClass} font-mono leading-relaxed`}
        />
        <FieldError message={errors?.body} />
      </div>
      <div className="max-w-md">
        <FieldLabel htmlFor="post-schedule">Planned publication</FieldLabel>
        <ScheduleField id="post-schedule" initialIso={post.scheduledFor} disabled={readOnly} error={errors?.scheduledFor} />
      </div>
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pendingLabel="Saving…" testId="save-post">
            Save changes
          </SubmitButton>
          {/* Success is shown by PostEditor: this form re-mounts after a save. */}
          <ActionFeedback state={state && !state.ok && state.code !== "version_conflict" ? state : null} testId="save-post" />
        </div>
      )}
    </form>
  );
}

/**
 * Editor with version-conflict handling: on conflict the user's unsaved text is
 * kept in a banner (to copy) and they can load the latest version explicitly.
 */
export function PostEditor({ post, readOnly }: { post: EditablePost; readOnly: boolean }) {
  const router = useRouter();
  const [conflict, setConflict] = useState<ConflictSnapshot | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  return (
    <div className="space-y-4">
      {savedVersion !== null && savedVersion === post.version && !conflict ? (
        <Notice tone="success" testId="save-post-success">
          Saved as version {savedVersion}.
        </Notice>
      ) : null}
      {conflict ? (
        <div
          role="alert"
          data-testid="version-conflict"
          className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          <p className="font-medium">Someone else changed this post after you opened it.</p>
          <p>
            Your changes were <strong>not saved</strong>, and nothing was overwritten. Load the latest version, then
            reapply your changes. Your unsaved text is below so you can copy it.
          </p>
          <details>
            <summary className="cursor-pointer font-medium">Your unsaved text</summary>
            <p className="mt-2 font-medium">{conflict.title}</p>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 font-mono text-xs dark:bg-black/30">
              {conflict.body}
            </pre>
          </details>
          <div className="flex gap-2">
            <button type="button" className={buttonClass.primary} onClick={() => router.refresh()} data-testid="load-latest">
              Load latest version
            </button>
            <button type="button" className={buttonClass.ghost} onClick={() => setConflict(null)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      <EditForm
        key={post.version}
        post={post}
        readOnly={readOnly}
        onConflict={(snapshot) => {
          setSavedVersion(null);
          setConflict(snapshot);
        }}
        onSaved={(version) => {
          setConflict(null);
          setSavedVersion(version);
        }}
      />
    </div>
  );
}

function versionHint(state: ActionResult<PostActionData> | null) {
  return state && !state.ok && state.code === "version_conflict"
    ? " Reload the page to get the latest version."
    : "";
}

/** draft <-> ready. Only the status changes (title, body and schedule are kept as stored). */
export function StatusSwitch({ post }: { post: EditablePost }) {
  const [state, action] = useActionState<State, FormData>(setPostStatusAction, null);
  const target = post.status === "ready" ? "draft" : "ready";
  return (
    <form action={action} className="space-y-2" data-testid="status-switch">
      <input type="hidden" name="postId" value={post.id} />
      <input type="hidden" name="expectedVersion" value={post.version} />
      <input type="hidden" name="status" value={target} />
      <SubmitButton
        variant={target === "ready" ? "primary" : "secondary"}
        pendingLabel="Updating…"
        testId={target === "ready" ? "mark-ready" : "back-to-draft"}
      >
        {target === "ready" ? "Mark as ready" : "Move back to draft"}
      </SubmitButton>
      {state && !state.ok ? (
        <Notice tone={state.code === "version_conflict" ? "warning" : "error"} testId="status-switch-error">
          {state.error}
          {versionHint(state)}
        </Notice>
      ) : null}
    </form>
  );
}

/** Archive / restore (never a permanent delete). */
export function ArchivePostButton({ post, projectArchived }: { post: EditablePost; projectArchived: boolean }) {
  const archived = post.archivedAt !== null;
  const [state, action] = useActionState<State, FormData>(archived ? restorePostAction : archivePostAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="postId" value={post.id} />
      <input type="hidden" name="expectedVersion" value={post.version} />
      <SubmitButton
        variant={archived ? "secondary" : "warning"}
        pendingLabel={archived ? "Restoring…" : "Archiving…"}
        disabled={archived && projectArchived}
        testId={archived ? "restore-post" : "archive-post"}
      >
        {archived ? "Restore post" : "Archive post"}
      </SubmitButton>
      {archived && projectArchived ? (
        <p className="text-xs text-slate-500">Restore the project first to restore this post.</p>
      ) : null}
      {state && !state.ok ? (
        <Notice tone={state.code === "version_conflict" ? "warning" : "error"} testId="archive-post-error">
          {state.error}
          {versionHint(state)}
        </Notice>
      ) : null}
    </form>
  );
}

