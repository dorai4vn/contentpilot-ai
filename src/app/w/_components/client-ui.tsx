"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import type { ActionState } from "@/app/_actions/content/action-result";
import { formatDateTime } from "@/lib/content/datetime";

import { Notice, buttonClass } from "./ui";

const noopSubscribe = () => () => {};

/** False during server rendering and hydration, true afterwards (browser time zone known). */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Shows a date-time in the viewer's local time zone. The server (and the first
 * client render) shows UTC so hydration matches; the local time replaces it once mounted.
 */
export function LocalDateTime({ iso, className }: { iso: string; className?: string }) {
  const mounted = useMounted();
  return (
    <time dateTime={iso} className={className} title={formatDateTime(iso, { timeZone: "UTC" }) + " UTC"}>
      {mounted ? formatDateTime(iso) : `${formatDateTime(iso, { timeZone: "UTC" })} UTC`}
    </time>
  );
}

export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  disabled,
  testId,
  name,
  value,
}: {
  children: ReactNode;
  pendingLabel: string;
  variant?: keyof typeof buttonClass;
  disabled?: boolean;
  testId?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending || disabled}
      aria-busy={pending}
      data-testid={testId}
      className={buttonClass[variant]}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

/** Success / error message for an action result (errors are already generic and safe). */
export function ActionFeedback<T>({
  state,
  success,
  testId = "action-feedback",
}: {
  state: ActionState<T>;
  success?: string;
  testId?: string;
}) {
  if (!state) return null;
  if (state.ok) return success ? <Notice tone="success" testId={`${testId}-success`}>{success}</Notice> : null;
  return (
    <Notice tone={state.code === "version_conflict" ? "warning" : "error"} testId={`${testId}-error`}>
      {state.error}
    </Notice>
  );
}
