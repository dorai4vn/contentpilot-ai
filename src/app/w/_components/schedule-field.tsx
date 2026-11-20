"use client";

import { useState } from "react";

import { isoToLocalInput, localInputToIso } from "@/lib/content/datetime";

import { useMounted } from "./client-ui";
import { FieldError, buttonClass, inputClass } from "./ui";

/**
 * Planned publication time. The visible input is a browser-local
 * <input type="datetime-local">; the submitted value is the hidden `scheduledFor`
 * field, always ISO 8601 in UTC (or empty = not scheduled).
 *
 * Until the user edits it, the hidden field carries the stored value unchanged,
 * so saving other fields never shifts the schedule (the local input only has
 * minute precision). The local input renders after mount, when the browser's
 * time zone is known, so server and client HTML match.
 */
export function ScheduleField({
  id,
  initialIso,
  disabled,
  error,
}: {
  id: string;
  initialIso: string | null;
  disabled?: boolean;
  error?: string;
}) {
  const mounted = useMounted();
  const [edited, setEdited] = useState<{ local: string } | null>(null);

  const local = edited ? edited.local : isoToLocalInput(initialIso);
  const converted = edited ? localInputToIso(edited.local) : undefined;
  const invalid = edited !== null && converted === undefined;
  const hiddenValue = edited ? (converted ?? "") : (initialIso ?? "");

  return (
    <div>
      <div className="flex gap-2">
        <input
          id={id}
          type="datetime-local"
          data-testid="schedule-input"
          value={mounted ? local : ""}
          disabled={disabled || !mounted}
          onChange={(event) => setEdited({ local: event.target.value })}
          aria-invalid={invalid || Boolean(error)}
          aria-describedby={`${id}-help`}
          className={inputClass}
        />
        {local && !disabled ? (
          <button
            type="button"
            className={buttonClass.ghost}
            onClick={() => setEdited({ local: "" })}
            data-testid="schedule-clear"
          >
            Bỏ lịch
          </button>
        ) : null}
      </div>
      <input type="hidden" name="scheduledFor" value={invalid ? "invalid" : hiddenValue} data-testid="schedule-iso" />
      <p id={`${id}-help`} className="mt-1 text-xs text-slate-500">
        Theo giờ trên máy của bạn, được lưu dưới dạng UTC{hiddenValue && !invalid ? ` (${hiddenValue})` : ""}. Để trống nếu
        chưa lên lịch.
      </p>
      <FieldError message={invalid ? "Vui lòng nhập ngày giờ hợp lệ." : error} />
    </div>
  );
}
