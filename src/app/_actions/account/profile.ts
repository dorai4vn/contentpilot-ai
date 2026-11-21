"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/dal";
import { type MyProfile, updateMyDisplayName } from "@/lib/profiles/profiles";
import { profileUpdateSchema } from "@/lib/validation/profile";

import { type ActionResult, type ActionState, parseForm, runAction } from "../content/action-result";

/**
 * Account page: the signed-in user sets their own display name. The form sends
 * only `displayName`; any other field (user_id, role, email…) is rejected and the
 * database takes the user id from the session.
 */
export async function updateDisplayNameAction(
  _prev: ActionState<MyProfile>,
  formData: FormData,
): Promise<ActionResult<MyProfile>> {
  await requireUser("/account");
  const input = parseForm(profileUpdateSchema, formData);
  if (!input.ok) return input.result;
  return runAction(
    () => updateMyDisplayName(input.data),
    (profile) => {
      revalidatePath("/account");
      // Names appear in approval history across the user's workspaces.
      revalidatePath("/w/[workspaceId]", "layout");
      return profile;
    },
  );
}
