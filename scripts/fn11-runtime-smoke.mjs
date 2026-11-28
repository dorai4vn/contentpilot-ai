// FN11-A3 runtime smoke: loads the local SigLIP pipeline on a synthetic image and prints timings/RSS.
// No secrets, no network except the pinned Hugging Face model download. Usage: node scripts/fn11-runtime-smoke.mjs [cacheDir]
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const REVISION = "4649052661e53c7000355844105f8a1792088239";
const t0 = Date.now();
const rss = () => Math.round(process.memoryUsage().rss / 1e6);
const tf = await import("@huggingface/transformers");
tf.env.cacheDir = process.argv[2] || join(tmpdir(), "contentpilot-siglip");
tf.env.allowLocalModels = false;
const classify = await tf.pipeline("zero-shot-image-classification", "Xenova/siglip-base-patch16-224", { dtype: "q8", revision: REVISION });
const loadMs = Date.now() - t0;
const jpeg = await sharp({ create: { width: 384, height: 384, channels: 3, background: "#2e7d32" } }).jpeg().toBuffer();
const image = await tf.RawImage.fromBlob(new Blob([jpeg], { type: "image/jpeg" }));
const t1 = Date.now();
const out = await classify(image, ["a photo of football players playing a soccer match on a pitch", "a painting or artwork"]);
console.log(JSON.stringify({ loadMs, inferMs: Date.now() - t1, rssMb: rss(), top: out[0], synthetic: true }));
