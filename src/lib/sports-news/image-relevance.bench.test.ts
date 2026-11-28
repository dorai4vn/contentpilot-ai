import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateImageRelevance } from "./image-relevance";

vi.mock("server-only", () => ({}));

/**
 * OPT-IN real-model benchmark (skipped in `npm run check`). Needs network for the one-off model download.
 * FN11_BENCH_DIR must contain meta.json: [{file, cls, title, split, hint?, method?}] where split is "calibration" or "holdout" with cls "pos_*" (should pass) or "neg_*" (should reject).
 * Uses the REAL local SigLIP model through the production validator, with method=og_image (worst case: provenance
 * trusted, so only the model decides).
 */
const dir = process.env.FN11_BENCH_DIR;
describe.skipIf(!dir || !existsSync(join(dir, "meta.json")))("FN11-A2 real-model benchmark", () => {
  it("classifies the disposable benchmark set", async () => {
    const meta: { file: string; cls: string; title: string; split?: string; hint?: string; method?: string }[] = JSON.parse(readFileSync(join(dir!, "meta.json"), "utf8"));
    const rows: { cls: string; title: string; split: string; ms: number; verdict: Awaited<ReturnType<typeof validateImageRelevance>> }[] = [];
    let peak = process.memoryUsage().rss;
    for (const m of meta) {
      const started = performance.now();
      const verdict = await validateImageRelevance(readFileSync(join(dir!, m.file)), { title: m.title, method: m.method ?? "og_image", hint: m.hint, sourceUrl: "https://x.example/a.jpg" });
      const ms = Math.round(performance.now() - started);
      peak = Math.max(peak, process.memoryUsage().rss);
      rows.push({ cls: m.cls, title: m.title, split: m.split ?? "calibration", ms, verdict });
    }
    // Confusion counts per split. Thresholds must be tuned on "calibration" only; "holdout" is reported, never tuned on.
    const confusion = (split: string) => {
      const part = rows.filter((r) => r.split === split);
      const pos = part.filter((r) => r.cls.startsWith("pos"));
      const neg = part.filter((r) => r.cls.startsWith("neg"));
      return {
        split, positives: pos.length, truePass: pos.filter((r) => r.verdict.ok).length, falseReject: pos.filter((r) => !r.verdict.ok).length,
        negatives: neg.length, falseAccept: neg.filter((r) => r.verdict.ok).length, trueReject: neg.filter((r) => !r.verdict.ok).length,
        byClass: Object.fromEntries([...new Set(part.map((r) => r.cls))].map((c) => [c, part.filter((r) => r.cls === c && r.verdict.ok).length + "/" + part.filter((r) => r.cls === c).length + " passed"])),
      };
    };
    const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
    const summary = {
      calibration: confusion("calibration"), holdout: confusion("holdout"),
      latencyMs: { p50: lat[Math.floor(lat.length / 2)], max: lat[lat.length - 1] }, peakRssMB: Math.round(peak / 1e6), rows,
    };
    writeFileSync(join(dir!, "bench-result.json"), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify({ ...summary, rows: undefined }));
    expect(summary.holdout.falseAccept).toBe(0);
  }, 600_000);
});
