import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateImageRelevance } from "./image-relevance";

vi.mock("server-only", () => ({}));

/**
 * OPT-IN real-model benchmark (skipped in `npm run check`). Needs network for the one-off model download.
 * FN11_BENCH_DIR must contain meta.json: [{file, cls, title}] with cls "pos_*" (should pass) or "neg_*" (should reject).
 * Uses the REAL local SigLIP model through the production validator, with method=og_image (worst case: provenance
 * trusted, so only the model decides).
 */
const dir = process.env.FN11_BENCH_DIR;
describe.skipIf(!dir || !existsSync(join(dir, "meta.json")))("FN11-A2 real-model benchmark", () => {
  it("classifies the disposable benchmark set", async () => {
    const meta: { file: string; cls: string; title: string }[] = JSON.parse(readFileSync(join(dir!, "meta.json"), "utf8"));
    const rows = [];
    let peak = process.memoryUsage().rss;
    for (const m of meta) {
      const started = performance.now();
      const verdict = await validateImageRelevance(readFileSync(join(dir!, m.file)), { title: "Arsenal thắng Man City", method: "og_image", sourceUrl: "https://x.example/a.jpg" });
      const ms = Math.round(performance.now() - started);
      peak = Math.max(peak, process.memoryUsage().rss);
      rows.push({ cls: m.cls, title: m.title, ms, verdict });
    }
    const pos = rows.filter((r) => r.cls.startsWith("pos"));
    const neg = rows.filter((r) => r.cls.startsWith("neg"));
    const summary = {
      positives: pos.length, truePass: pos.filter((r) => r.verdict.ok).length,
      negatives: neg.length, falseAccept: neg.filter((r) => r.verdict.ok).length,
      peakRssMB: Math.round(peak / 1e6), rows,
    };
    writeFileSync(join(dir!, "bench-result.json"), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify({ ...summary, rows: undefined }));
    expect(summary.falseAccept).toBe(0);
  }, 600_000);
});
