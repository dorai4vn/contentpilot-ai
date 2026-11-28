/**
 * FN11-A3b: ONE candidate/time budget per article, shared by every image source (article discovery, search provider
 * and the Wikimedia fallback). Each candidate download/validation consumes one slot, so the combined total is <= max.
 */
export const IMAGE_MAX_CANDIDATES = 5;
export const IMAGE_SCAN_BUDGET_MS = 90_000;

export type ImageBudget = { take(): boolean; readonly used: number; readonly exhausted: boolean };

export function createImageBudget(max: number = IMAGE_MAX_CANDIDATES, totalMs: number = IMAGE_SCAN_BUDGET_MS, now: () => number = Date.now): ImageBudget {
  const deadline = now() + totalMs;
  let used = 0;
  return {
    take() {
      if (used >= max || now() >= deadline) return false;
      used += 1;
      return true;
    },
    get used() { return used; },
    get exhausted() { return used >= max || now() >= deadline; },
  };
}
