"use client";

import { CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  type BulkApproveItemResult,
  bulkApprovePublishAction,
} from "@/app/_actions/content/publish";
import { BULK_APPROVE_MAX } from "@/lib/validation/publish-actions";

import { Notice, buttonClass } from "./ui";

/**
 * Bulk approval of the visible pending requests (issue #26). It only calls
 * bulkApprovePublishAction, which reuses the single-approval data layer per item.
 * Selection is local to the visible page: nothing hidden or cross-page is ever
 * submitted. One explicit confirmation lists the count and the destinations.
 */

export type BulkQueueItem = {
  requestId: string;
  title: string;
  postVersion: number;
  destinationId: string;
  destinationName: string;
  /** Pending and decidable by the current user. */
  eligible: boolean;
  className: string;
  status: string;
  children: ReactNode;
};

/** One line of the persistent result report (kept even when every row disappears). */
type ReportRow = {
  requestId: string;
  title: string;
  destinationName: string;
  result: BulkApproveItemResult;
};

const CARD =
  "rounded-xl border border-border bg-surface shadow-card text-foreground";

/**
 * Mount with a `key` built from workspace + filter + page: a different scope
 * remounts the component, which resets selection, confirmation and report.
 * `emptyState` is rendered inside, so the result report survives the refresh
 * that empties the queue after an all-success batch.
 */
export function BulkApprovalList({
  workspaceId,
  items,
  emptyState,
}: {
  workspaceId: string;
  items: BulkQueueItem[];
  emptyState?: ReactNode;
}) {
  const router = useRouter();
  const groupId = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Exactly what the approver confirmed; the submit payload is built from it.
  const [confirmation, setConfirmation] = useState<BulkQueueItem[] | null>(
    null,
  );
  const [report, setReport] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const inFlight = useRef(false);
  const startRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  const eligible = useMemo(() => items.filter((i) => i.eligible), [items]);
  const eligibleIds = useMemo(
    () => new Set(eligible.map((i) => i.requestId)),
    [eligible],
  );
  // Only ids still on the page and eligible count.
  const chosen = eligible.filter((i) => selected.has(i.requestId));
  const tooMany = chosen.length > BULK_APPROVE_MAX;
  const allSelected = eligible.length > 0 && chosen.length === eligible.length;

  // The confirmation is valid only while every confirmed item is still on the
  // page, eligible, with the same version, destination and selected. Anything
  // else (refresh, selection change) silently invalidates it: it can never
  // submit a payload different from what the approver read.
  const confirmValid =
    confirmation !== null &&
    confirmation.length === chosen.length &&
    confirmation.every((c) => {
      const now = eligible.find((i) => i.requestId === c.requestId);
      return (
        now !== undefined &&
        selected.has(c.requestId) &&
        now.postVersion === c.postVersion &&
        now.destinationId === c.destinationId
      );
    });
  const confirming = confirmValid ? confirmation : null;

  // Keyboard: opening the confirmation moves focus to it (not to the approve
  // button, so a stray Enter cannot approve); Escape cancels and returns focus.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeConfirm = (restoreFocus: boolean) => {
    setConfirmation(null);
    if (restoreFocus) queueMicrotask(() => startRef.current?.focus());
  };

  const toggle = (id: string, on: boolean) => {
    if (busy) return;
    setConfirmation(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const selectAll = (on: boolean) => {
    if (busy) return;
    setConfirmation(null);
    setSelected(
      on
        ? new Set(eligible.slice(0, BULK_APPROVE_MAX).map((i) => i.requestId))
        : new Set(),
    );
  };
  const clear = () => {
    if (busy) return;
    setConfirmation(null);
    setSelected(new Set());
  };

  const destinationSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of confirming ?? [])
      counts.set(i.destinationName, (counts.get(i.destinationName) ?? 0) + 1);
    return [...counts.entries()];
  }, [confirming]);

  const submit = () => {
    if (inFlight.current || busy || !confirming || tooMany) return;
    inFlight.current = true;
    setError(null);
    const batch = confirming;
    const payload = {
      workspaceId,
      confirm: "approve",
      items: batch.map((i) => ({
        requestId: i.requestId,
        expectedPostVersion: i.postVersion,
        expectedDestinationId: i.destinationId,
      })),
    };
    startTransition(async () => {
      try {
        const res = await bulkApprovePublishAction(payload);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        const byId = new Map(batch.map((i) => [i.requestId, i]));
        setReport(
          res.data.results.map((r) => ({
            requestId: r.requestId,
            title: byId.get(r.requestId)?.title ?? r.requestId,
            destinationName: byId.get(r.requestId)?.destinationName ?? "",
            result: r,
          })),
        );
        // Succeeded items leave the selection; failed ones stay selected (the
        // `chosen` filter drops those that are no longer eligible after refresh).
        setSelected(
          new Set(
            res.data.results.filter((r) => !r.ok).map((r) => r.requestId),
          ),
        );
        setConfirmation(null);
        router.refresh();
      } catch {
        setError(
          "Không thể hoàn tất yêu cầu. Vui lòng tải lại trang và kiểm tra trạng thái từng yêu cầu.",
        );
      } finally {
        inFlight.current = false;
      }
    });
  };

  const resultById = new Map(report?.map((r) => [r.requestId, r.result]));
  const okCount = report?.filter((r) => r.result.ok).length ?? 0;
  const failCount = (report?.length ?? 0) - okCount;
  const failedGone = (report ?? []).filter(
    (r) => !r.result.ok && !eligibleIds.has(r.requestId),
  ).length;

  return (
    <div className="space-y-3">
      {eligible.length > 0 ? (
        <div
          className={`sticky top-2 z-10 flex flex-wrap items-center gap-3 p-3 ${CARD}`}
          data-testid="bulk-toolbar"
        >
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border accent-primary"
              checked={allSelected}
              disabled={busy}
              onChange={(e) => selectAll(e.target.checked)}
              data-testid="bulk-select-all"
            />
            Chọn tất cả yêu cầu đang chờ duyệt trên trang này
          </label>
          <span
            className="text-sm text-muted"
            role="status"
            aria-live="polite"
            data-testid="bulk-count"
          >
            Đã chọn {chosen.length}/{eligible.length}
            {tooMany ? ` — tối đa ${BULK_APPROVE_MAX} mỗi lần` : ""}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={clear}
              disabled={busy || chosen.length === 0}
              data-testid="bulk-clear"
            >
              Bỏ chọn
            </button>
            <button
              ref={startRef}
              type="button"
              className={buttonClass.primary}
              onClick={() => setConfirmation(chosen)}
              disabled={busy || chosen.length === 0 || tooMany}
              data-testid="bulk-approve-start"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Phê duyệt đã chọn ({chosen.length})
            </button>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div
          ref={confirmRef}
          tabIndex={-1}
          className="space-y-3 rounded-xl border border-border bg-(--accent) p-4 text-sm leading-6 text-foreground shadow-card outline-none focus-visible:ring-2 focus-visible:ring-primary"
          role="alertdialog"
          aria-labelledby={`${groupId}-title`}
          aria-describedby={`${groupId}-summary`}
          data-testid="bulk-confirm"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) {
              e.stopPropagation();
              closeConfirm(true);
            }
          }}
        >
          <p
            id={`${groupId}-title`}
            className="flex items-center gap-2 font-semibold"
          >
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
            Xác nhận phê duyệt hàng loạt
          </p>
          <p id={`${groupId}-summary`} data-testid="bulk-confirm-summary">
            Bạn sắp phê duyệt <strong>{confirming.length}</strong> yêu cầu đúng
            phiên bản đang hiển thị. Đích xuất bản:{" "}
            {destinationSummary.map(([name, n], idx) => (
              <span key={name}>
                {idx > 0 ? ", " : ""}
                <strong>{name}</strong> ({n})
              </span>
            ))}
            . Nếu đích là kênh bên ngoài, nội dung sẽ được đưa vào hàng chờ gửi.
            Từng yêu cầu được kiểm tra riêng; yêu cầu lỗi sẽ được giữ lại để bạn
            xem.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.primary}
              onClick={submit}
              disabled={busy}
              aria-busy={busy}
              data-testid="bulk-confirm-submit"
            >
              {busy
                ? "Đang phê duyệt…"
                : `Xác nhận phê duyệt ${confirming.length} yêu cầu`}
            </button>
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => closeConfirm(true)}
              disabled={busy}
              data-testid="bulk-confirm-cancel"
            >
              Quay lại
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <Notice tone="error" testId="bulk-error">
          {error}
        </Notice>
      ) : null}

      {report ? (
        <section
          className={`space-y-2 p-4 ${CARD}`}
          aria-labelledby={`${groupId}-report`}
          data-testid="bulk-result"
          data-ok-count={okCount}
          data-fail-count={failCount}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              id={`${groupId}-report`}
              className="text-sm font-semibold"
              role="status"
            >
              Kết quả phê duyệt hàng loạt: {okCount}/{report.length} thành công
              {failCount > 0 ? `, ${failCount} lỗi` : ""}
            </h2>
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => setReport(null)}
              disabled={busy}
              data-testid="bulk-result-dismiss"
            >
              Đóng kết quả
            </button>
          </div>
          {failedGone > 0 ? (
            <p className="text-xs text-muted" data-testid="bulk-result-gone">
              {failedGone} yêu cầu lỗi không còn đủ điều kiện duyệt trong hàng
              chờ (đã được xử lý, hết hạn hoặc bị gỡ) nên không còn được chọn.
            </p>
          ) : null}
          <ul className="divide-y divide-border text-sm">
            {report.map((r) => (
              <li
                key={r.requestId}
                className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2"
                data-testid="bulk-result-row"
                data-ok={r.result.ok}
                data-still-eligible={eligibleIds.has(r.requestId)}
              >
                {r.result.ok ? (
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                    aria-hidden
                  />
                ) : (
                  <XCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-red-600"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{r.title}</span>
                  {r.destinationName ? (
                    <span className="text-muted"> · {r.destinationName}</span>
                  ) : null}
                  <span
                    className={`block text-xs ${r.result.ok ? "text-emerald-700" : "text-red-700"}`}
                  >
                    {r.result.ok
                      ? r.result.postStatus === "published"
                        ? "Đã phê duyệt và xuất bản."
                        : "Đã phê duyệt, đang chờ gửi."
                      : `Không phê duyệt được: ${r.result.error}${
                          eligibleIds.has(r.requestId)
                            ? " (vẫn được chọn để xem lại)"
                            : " (không còn đủ điều kiện, đã bỏ chọn)"
                        }`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {items.length === 0 ? emptyState : null}

      <ul
        className={items.length ? "space-y-2" : "hidden"}
        data-testid="approval-list"
      >
        {items.map((i) => {
          const result = resultById.get(i.requestId);
          const checkboxId = `${groupId}-${i.requestId}`;
          return (
            <li
              key={i.requestId}
              className={i.className}
              data-testid="approval-item"
              data-request-id={i.requestId}
              data-status={i.status}
            >
              <div className="flex items-start gap-3">
                {i.eligible || eligibleIds.size > 0 ? (
                  <div className="pt-1">
                    {i.eligible ? (
                      <input
                        id={checkboxId}
                        type="checkbox"
                        className="h-4 w-4 rounded border-border accent-primary"
                        checked={selected.has(i.requestId)}
                        disabled={busy}
                        onChange={(e) => toggle(i.requestId, e.target.checked)}
                        aria-label={`Chọn “${i.title}” (phiên bản ${i.postVersion}) để phê duyệt`}
                        data-testid="bulk-item-checkbox"
                      />
                    ) : (
                      <span className="inline-block h-4 w-4" aria-hidden />
                    )}
                  </div>
                ) : null}
                <div className="min-w-0 flex-1">
                  {i.children}
                  {result && !result.ok ? (
                    <p
                      className="mt-2 text-xs font-medium text-red-700"
                      data-testid="bulk-item-result"
                      data-ok="false"
                    >
                      Không phê duyệt được: {result.error}
                    </p>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
