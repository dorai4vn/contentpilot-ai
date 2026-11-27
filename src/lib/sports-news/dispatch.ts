import "server-only";

import { logSafeError, safeErrorInfo } from "@/lib/logging/safe-log";
import { DISPATCH_TIME_BUDGET_MS, readSportsNewsConfig, runSportsDelivery } from "./worker";

/**
 * Prompt post-approval dispatch. Called after a human approval has been
 * committed by the database RPC; it only asks the existing delivery worker to
 * process already-approved deliveries. It never approves, drafts or reads RSS,
 * and credentials stay on the server (worker env). The database claim
 * (FOR UPDATE SKIP LOCKED + status transitions) is the real guard against double
 * sends; the in-process coalescing below only avoids redundant work, e.g. eight
 * approvals in a row. A failure here is harmless: the delivery stays queued and
 * the scheduled delivery-only run (and the 2-hour run) picks it up.
 */
let running: Promise<void> | null = null;
let again = false;

async function drain() {
  do {
    again = false;
    try {
      await runSportsDelivery(readSportsNewsConfig(), Date.now, DISPATCH_TIME_BUDGET_MS);
    } catch (error) {
      logSafeError("sports-dispatch", { ...safeErrorInfo(error), reason: "dispatch_failed" });
      return;
    }
  } while (again);
}

export function dispatchApprovedDeliveries(workspaceId: string): Promise<void> {
  let configured: string | undefined;
  try {
    configured = readSportsNewsConfig().workspaceId;
  } catch {
    return Promise.resolve(); // worker not configured in this environment: nothing to dispatch
  }
  if (configured !== workspaceId) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = drain().finally(() => {
    running = null;
  });
  return running;
}
