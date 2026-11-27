"use client";

import { CheckCircle2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
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

export function BulkApprovalList({
  workspaceId,
  items,
}: {
  workspaceId: string;
  items: BulkQueueItem[];
}) {
  const router = useRouter();
  const groupId = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [results, setResults] = useState<Map<string, BulkApproveItemResult>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const inFlight = useRef(false);

  const eligible = useMemo(() => items.filter((i) => i.eligible), [items]);
  const eligibleIds = useMemo(
    () => new Set(eligible.map((i) => i.requestId)),
    [eligible],
  );
  // Only ids still on the page and eligible count (the page refreshes after success).
  const chosen = eligible.filter((i) => selected.has(i.requestId));
  const tooMany = chosen.length > BULK_APPROVE_MAX;
  const allSelected = eligible.length > 0 && chosen.length === eligible.length;

  const toggle = (id: string, on: boolean) => {
    if (busy) return;
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const selectAll = (on: boolean) => {
    if (busy) return;
    setConfirming(false);
    setSelected(
      on
        ? new Set(eligible.slice(0, BULK_APPROVE_MAX).map((i) => i.requestId))
        : new Set(),
    );
  };
  const clear = () => {
    if (busy) return;
    setConfirming(false);
    setSelected(new Set());
  };

  const destinationSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of chosen)
      counts.set(i.destinationName, (counts.get(i.destinationName) ?? 0) + 1);
    return [...counts.entries()];
  }, [chosen]);

  const submit = () => {
    if (inFlight.current || busy || chosen.length === 0 || tooMany) return;
    inFlight.current = true;
    setError(null);
    const payload = {
      workspaceId,
      confirm: "approve",
      items: chosen.map((i) => ({
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
        setResults(new Map(res.data.results.map((r) => [r.requestId, r])));
        // Succeeded items leave the selection; failed ones stay selected for review.
        setSelected(
          new Set(
            res.data.results.filter((r) => !r.ok).map((r) => r.requestId),
          ),
        );
        setConfirming(false);
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

  const okCount = [...results.values()].filter((r) => r.ok).length;
  const failCount = results.size - okCount;

  return (
    <div className="space-y-3">
      {eligible.length > 0 ? (
        <div
          className="sticky top-2 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-card backdrop-blur"
          data-testid="bulk-toolbar"
        >
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
              checked={allSelected}
              disabled={busy}
              onChange={(e) => selectAll(e.target.checked)}
              data-testid="bulk-select-all"
            />
            Chọn tất cả yêu cầu đang chờ duyệt trên trang này
          </label>
          <span
            className="text-sm text-slate-600"
            role="status"
            aria-live="polite"
            data-testid="bulk-count"
          >
            Đã chọn {chosen.length}/{eligible.length}
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
              type="button"
              className={buttonClass.primary}
              onClick={() => setConfirming(true)}
              disabled={busy || chosen.length === 0 || tooMany}
              data-testid="bulk-approve-start"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Phê duyệt đã chọn ({chosen.length})
            </button>
          </div>
        </div>
      ) : null}

      {confirming && chosen.length > 0 ? (
        <div
          className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/70 p-4 text-sm leading-6 text-indigo-950 shadow-card"
          role="alertdialog"
          aria-labelledby={`${groupId}-title`}
          data-testid="bulk-confirm"
        >
          <p
            id={`${groupId}-title`}
            className="flex items-center gap-2 font-semibold"
          >
            <ShieldCheck className="h-4 w-4 text-indigo-600" aria-hidden />
            Xác nhận phê duyệt hàng loạt
          </p>
          <p data-testid="bulk-confirm-summary">
            Bạn sắp phê duyệt <strong>{chosen.length}</strong> yêu cầu đúng
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
                : `Xác nhận phê duyệt ${chosen.length} yêu cầu`}
            </button>
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => setConfirming(false)}
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
      {results.size > 0 ? (
        <Notice
          tone={failCount > 0 ? "warning" : "success"}
          testId="bulk-result"
        >
          Đã phê duyệt {okCount}/{results.size} yêu cầu
          {failCount > 0
            ? `; ${failCount} yêu cầu lỗi vẫn được chọn bên dưới.`
            : "."}
        </Notice>
      ) : null}

      <ul className="space-y-2" data-testid="approval-list">
        {items.map((i) => {
          const result = results.get(i.requestId);
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
                        className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
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
                  {result ? (
                    <p
                      className={`mt-2 text-xs font-medium ${result.ok ? "text-emerald-700" : "text-red-700"}`}
                      role="status"
                      data-testid="bulk-item-result"
                      data-ok={result.ok}
                    >
                      {result.ok
                        ? result.postStatus === "published"
                          ? "Đã phê duyệt và xuất bản."
                          : "Đã phê duyệt, đang chờ gửi."
                        : `Không phê duyệt được: ${result.error}`}
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
