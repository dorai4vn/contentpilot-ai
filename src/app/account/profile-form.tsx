"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { updateDisplayNameAction } from "@/app/_actions/account/profile";
import type { ActionState } from "@/app/_actions/content/action-result";
import { ActionFeedback, SubmitButton } from "@/app/w/_components/client-ui";
import { FieldError, FieldLabel, inputClass } from "@/app/w/_components/ui";
import type { MyProfile } from "@/lib/profiles/profiles";
import { PROFILE_LIMITS } from "@/lib/validation/profile";

/** Sets the signed-in user's display name. Sends only `displayName`. */
export function ProfileForm({ displayName }: { displayName: string | null }) {
  const [state, action] = useActionState<ActionState<MyProfile>, FormData>(updateDisplayNameAction, null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={action} className="space-y-3" data-testid="profile-form">
      <div>
        <FieldLabel htmlFor="display-name">Tên hiển thị</FieldLabel>
        <input
          id="display-name"
          name="displayName"
          required
          maxLength={PROFILE_LIMITS.displayNameMax}
          defaultValue={displayName ?? ""}
          autoComplete="name"
          className={inputClass}
          data-testid="profile-display-name"
        />
        <FieldError message={errors?.displayName} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Đang lưu…" testId="profile-save">
          Lưu tên hiển thị
        </SubmitButton>
        <ActionFeedback state={state} success="Đã lưu tên hiển thị." testId="profile-save" />
      </div>
    </form>
  );
}
