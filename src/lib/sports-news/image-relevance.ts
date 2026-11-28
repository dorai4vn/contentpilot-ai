import "server-only";

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { squareSportsPhoto } from "./square-photo";

/**
 * FN11-A2 local, zero-API-cost image relevance validation (hybrid).
 *
 * Evidence combined (ALL must hold, otherwise the candidate is rejected = fail closed):
 *  1. Technical: decodes, crops to the 1080x1080 square used for delivery.
 *  2. Provenance: image came from the article itself (RSS media/OG/JSON-LD/lead) on an allowlisted host, OR carries a
 *     text hint/filename that corroborates the article entity; and no age-group conflict between title and hint.
 *  3. Local CPU SigLIP zero-shot scores: a football-class score must clear a threshold and clearly beat every negative
 *     class (artwork, building, street, logo, empty stadium, non-football...).
 *
 * LIMITATION (do not overstate): the model recognises "football scene vs not". It CANNOT reliably identify specific
 * players, the exact teams, the age group or the event from pixels. Those come from provenance only. Thresholds were
 * calibrated on a very small sample (see docs/architecture/fn11-image-pipeline.md).
 * No network call to a paid API is made; the model is downloaded once from a pinned Hugging Face revision.
 */

export const IMAGE_MODEL_ID = "Xenova/siglip-base-patch16-224"; // ONNX export of google/siglip-base-patch16-224 (Apache-2.0)
export const IMAGE_MODEL_REVISION = "4649052661e53c7000355844105f8a1792088239";
export const IMAGE_POLICY_VERSION = "fn11-a2.1";

export const FOOTBALL_PROMPTS = [
  "a photo of football players playing a soccer match on a pitch",
  "a photo of a footballer in action during a soccer game",
  "a photo of football players celebrating a goal",
] as const;
export const NEGATIVE_PROMPTS = [
  "a painting or artwork",
  "a photo of a building exterior",
  "a photo of a city street or seafront",
  "a club logo or badge",
  "an empty stadium with no players",
  "a photo of a landscape or nature",
  "a portrait of a person not playing sport",
  "a photo of basketball or another sport",
] as const;

export type RelevanceScores = { football: number; negative: number; topNegative: string };
/** Pluggable scorer so tests can inject a MOCK. The default one is the real local model. */
export type ImageScorer = (jpeg: Uint8Array) => Promise<RelevanceScores>;

export type RelevanceContext = {
  title: string;
  /** How the image was found. Article-embedded methods are corroborated by provenance. */
  method: string;
  /** Alt text / filename / caption text of the candidate, when known. */
  hint?: string;
  sourceUrl: string;
};

export type RelevanceVerdict =
  | { ok: true; football: number; negative: number; cached: boolean; modelVersion: string }
  | { ok: false; reason: RelevanceRejection };

export type RelevanceRejection =
  | "model_unavailable" | "model_timeout" | "model_error" | "decode_failed" | "crop_failed"
  | "age_group_conflict" | "not_corroborated" | "low_football_score" | "negative_class" | "ambiguous";

const ARTICLE_METHODS = ["rss_media", "og_image", "twitter_image", "json_ld", "lead_image"];
export const DEFAULT_THRESHOLDS = { football: 0.15, margin: 3, timeoutMs: 25_000 } as const;

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Age group tags such as U17 / U-19 / under 20. Returns a set of numbers. */
export function ageGroups(text: string): Set<number> {
  const out = new Set<number>();
  for (const match of text.toLowerCase().matchAll(/\b(?:u|under)[\s-]?(\d{2})\b/g)) out.add(Number(match[1]));
  return out;
}

/** Provenance checks that do not need the model. Exported for tests. */
export function provenanceRejection(ctx: RelevanceContext): RelevanceRejection | null {
  const hint = `${ctx.hint ?? ""} ${decodeURIComponentSafe(ctx.sourceUrl.split("?")[0])}`;
  const titleAges = ageGroups(ctx.title);
  const hintAges = ageGroups(hint);
  if (titleAges.size > 0 && hintAges.size > 0 && ![...hintAges].some((age) => titleAges.has(age))) return "age_group_conflict";
  // Senior-team story vs. an explicit youth image (or vice versa).
  if (titleAges.size === 0 && hintAges.size > 0) return "age_group_conflict";
  if (!ARTICLE_METHODS.includes(ctx.method) && !hasEntityOverlap(ctx.title, hint)) return "not_corroborated";
  return null;
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const STOP = new Set(["vs", "the", "and", "for", "with", "van", "cua", "tran", "doi", "jpg", "jpeg", "png", "webp", "image", "photo"]);
function entityTokens(text: string) {
  return new Set((text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").match(/[a-z0-9]{4,}/g) ?? [])
    .filter((token) => !STOP.has(token) && !/^\d+$/.test(token)));
}
function hasEntityOverlap(title: string, hint: string) {
  const wanted = entityTokens(title);
  return [...entityTokens(hint)].some((token) => wanted.has(token));
}

/** Pure decision rule over model scores. Exported for tests and calibration. */
export function decideFromScores(scores: RelevanceScores, football: number = DEFAULT_THRESHOLDS.football, margin: number = DEFAULT_THRESHOLDS.margin): RelevanceRejection | null {
  if (scores.football < football) return scores.negative >= football ? "negative_class" : "low_football_score";
  // Football must beat the strongest negative class by a clear factor; otherwise it is ambiguous.
  return scores.football >= scores.negative * margin ? null : "ambiguous";
}

type SigLipPipeline = (image: unknown, labels: string[]) => Promise<{ label: string; score: number }[]>;
let pipelinePromise: Promise<SigLipPipeline> | null = null;

/** Lazy singleton for the real local model. Any failure resolves to a rejected promise => fail closed (no retry storm). */
function loadPipeline(): Promise<SigLipPipeline> {
  pipelinePromise ??= (async () => {
    // Optional heavy dependency, loaded only when validation actually runs.
    const transformers = await import("@huggingface/transformers");
    transformers.env.cacheDir = process.env.SPORTS_IMAGE_MODEL_CACHE || join(tmpdir(), "contentpilot-siglip");
    transformers.env.allowLocalModels = false;
    const created = await transformers.pipeline("zero-shot-image-classification", IMAGE_MODEL_ID, {
      dtype: "q8", revision: IMAGE_MODEL_REVISION,
    });
    return created as unknown as SigLipPipeline;
  })();
  pipelinePromise.catch(() => { pipelinePromise = null; });
  return pipelinePromise;
}

export const localSigLipScorer: ImageScorer = async (jpeg) => {
  const classify = await loadPipeline();
  const labels = [...FOOTBALL_PROMPTS, ...NEGATIVE_PROMPTS];
  const { RawImage } = await import("@huggingface/transformers");
  const results = await classify(await RawImage.fromBlob(new Blob([Buffer.from(jpeg)], { type: "image/jpeg" })), labels);
  const byLabel = new Map(results.map((result) => [result.label, result.score]));
  const football = Math.max(...FOOTBALL_PROMPTS.map((label) => byLabel.get(label) ?? 0));
  let negative = 0;
  let topNegative = "";
  for (const label of NEGATIVE_PROMPTS) {
    const score = byLabel.get(label) ?? 0;
    if (score >= negative) { negative = score; topNegative = label; }
  }
  return { football, negative, topNegative };
};

const verdictCache = new Map<string, RelevanceVerdict>();
const CACHE_LIMIT = 200;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export type ValidateDeps = { scorer?: ImageScorer; footballThreshold?: number; margin?: number; timeoutMs?: number };

/**
 * Validates one candidate image. Never throws; any missing model, error, timeout or uncertainty yields `ok:false`.
 * Cached by image hash + event context + model/policy version (in-process; serverless instances do not share it).
 */
export async function validateImageRelevance(bytes: Uint8Array, ctx: RelevanceContext, deps: ValidateDeps = {}): Promise<RelevanceVerdict> {
  const provenance = provenanceRejection(ctx);
  if (provenance) return { ok: false, reason: provenance };

  const football = deps.footballThreshold ?? envNumber("SPORTS_IMAGE_FOOTBALL_THRESHOLD", DEFAULT_THRESHOLDS.football);
  const margin = deps.margin ?? envNumber("SPORTS_IMAGE_NEGATIVE_MARGIN", DEFAULT_THRESHOLDS.margin);
  const modelVersion = `${IMAGE_MODEL_ID}@${IMAGE_MODEL_REVISION.slice(0, 7)}/${IMAGE_POLICY_VERSION}/${football}/${margin}`;
  const key = createHash("sha256").update(bytes).update("\0").update(`${ctx.title}\0${ctx.method}\0${ctx.hint ?? ""}\0${modelVersion}`).digest("hex");
  const hit = verdictCache.get(key);
  if (hit) return hit.ok ? { ...hit, cached: true } : hit;

  let jpeg: Uint8Array;
  try {
    jpeg = await squareSportsPhoto(Buffer.from(bytes)); // proves the delivery crop works (no text fallback later)
  } catch {
    return { ok: false, reason: "crop_failed" };
  }
  let small: Uint8Array;
  try {
    small = await sharp(jpeg).resize(384, 384).jpeg({ quality: 85 }).toBuffer(); // bounded model input
  } catch {
    return { ok: false, reason: "decode_failed" };
  }

  let verdict: RelevanceVerdict;
  try {
    const scores = await withTimeout((deps.scorer ?? localSigLipScorer)(small), deps.timeoutMs ?? envNumber("SPORTS_IMAGE_QC_TIMEOUT_MS", DEFAULT_THRESHOLDS.timeoutMs));
    const rejection = decideFromScores(scores, football, margin);
    verdict = rejection ? { ok: false, reason: rejection }
      : { ok: true, football: scores.football, negative: scores.negative, cached: false, modelVersion };
  } catch (error) {
    // Do NOT cache infrastructure failures: the model may become available on a later run.
    return { ok: false, reason: error instanceof Error && error.message === "timeout" ? "model_timeout" : modelMissing(error) ? "model_unavailable" : "model_error" };
  }
  if (verdictCache.size >= CACHE_LIMIT) verdictCache.clear();
  verdictCache.set(key, verdict);
  return verdict;
}

function modelMissing(error: unknown) {
  return error instanceof Error && /cannot find|unauthorized|fetch failed|could not locate|ENOTFOUND|ENOENT|Module not found/i.test(error.message);
}

export function resetRelevanceStateForTests() {
  verdictCache.clear();
  pipelinePromise = null;
}
