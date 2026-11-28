# FN11 image pipeline (A1 acquisition → A2 validation → B gate)

## A1 — acquisition (`src/lib/sports-news/image-acquisition.ts`)
- Candidates in order: RSS media (`media:content`/`media:thumbnail`/image `enclosure`), `og:image`, `twitter:image`, JSON-LD `image`, first lead `<img>`; at most 5 tried per article (bounded substitution).
- Article hosts: built-in Vietnamese football sites plus `SPORTS_IMAGE_ALLOWED_HOSTS` (comma-separated public official club/league/fanpage hosts; no private/login-only hosts). Image hosts must be in the same policy.
- Safety: https only, no port/credentials/IP literal, DNS answers must be public, manual redirects (max 3) re-validated each hop, 8 s timeout, HTML ≤1 MB, image ≤5 MB, MIME + magic-byte signature + sharp-decoded format, 400–8000 px sides.
- Heuristic rejection (URL/alt text only): logo, icon, banner, placeholder, flag, painting, street, building, basketball, …
- Optional `ImageSearchProvider` adapter exists; **no provider is bundled or called**. Its candidates still pass the host allowlist. No paid API is used.
- Every result carries provenance and `verification: "local_hybrid"`, `visualQc: "local_pass"` plus `qc` scores, only AFTER the A2 validator passed. Metadata/OG/filename alone is never a pass.

## A2 — local zero-API-cost hybrid validation (`image-relevance.ts`, implemented)
- Model: `Xenova/siglip-base-patch16-224` (ONNX export of `google/siglip-base-patch16-224`, **Apache-2.0**), dtype `q8` (`onnx/model_quantized.onnx`, ~211 MB), revision pinned `4649052661e53c7000355844105f8a1792088239`; runtime `@huggingface/transformers@3.8.1` (Apache-2.0, exact pin) on CPU `onnxruntime-node`. `.npmrc` sets `onnxruntime-node-install-cuda=skip` so installs do not download CUDA binaries. No API key, no paid call, no automatic paid fallback. CLIP was not benchmarked (not justified: SigLIP met the sample).
- Per candidate (max 5, sequential, first pass wins): decode + 1080x1080 crop check -> provenance (article-embedded image on an allowlisted host, otherwise filename/alt must share an entity token with the title; U17/U19/U20 age-group conflict rejects) -> SigLIP zero-shot: best football prompt must be >= 0.15 and >= 3x the best negative class (artwork, building, street/seafront, logo, empty stadium, landscape, non-sport portrait, other sport). Otherwise reject.
- Fail closed: model missing / download failure / error / 25 s timeout / ambiguous => reject (not cached), so no image => B1 gate => no send.
- Cache: in-process by sha256(image) + title/method/hint + model@rev/policy/thresholds. Serverless instances do not share it.
- Wiring: `acquireSourceImage` (RSS/OG/JSON-LD/lead/search-provider candidates) and `validateFallbackPhoto` (Wikimedia/Commons) in `source-photo.ts`, both called from `worker.ts`. There is no path that stores an image without it.
- The model CANNOT reliably identify players, exact teams, age group or event from pixels; those come from provenance. Thresholds are calibrated on a tiny sample.
- Opt-in real benchmark: `FN11_BENCH_DIR=<dir with meta.json + images> npx vitest run src/lib/sports-news/image-relevance.bench.test.ts` (skipped in `npm run check`).

### Benchmark (GitHub-hosted Linux runner, 4 vCPU / 15.7 GB, Node 22, CPU only; 27 Wikimedia Commons images, permitted licences)
- Model files cached: ~204 MB. Cold: first image 863 ms incl. load (~0.5-1.3 s load + ~0.3 s inference); warm median ~260 ms/image (180-400 ms). Peak RSS ~0.93 GB (~0.58 GB after load).
- Positives (14 football match/youth photos): 10 pass, 4 false rejects (2 low-score, 1 flagged negative, 1 low score) = fail-closed cost, acceptable.
- Negatives (13: Canaletto/18th-c. paintings, Percy House/Tottenham building, Brighton seafront, Chelsea streets): **0 false accepts**, all rejected as `low_football_score`.
- NOT covered: no generic-stadium, logo or wrong-team football photos in the set (Commons search was rate-limited), so those negative classes are unmeasured. n=27 is far too small for calibrated rates.
- Actions-minutes estimate (not a hosting claim): ~0.3 s x <=5 candidates x <=3 posts/run ≈ <=5 s inference per run, plus a one-off ~10-60 s model download per fresh runner/instance. Cost depends on where the worker runs.

### Deployment limitation (open)
`sports-news.yml` only `curl`s the cron URL; the worker itself runs in the Next.js server (Vercel), not on the Actions runner. Whether Vercel serverless can load a ~200 MB ONNX model + `onnxruntime-node` (bundle size, writable cache, memory, cold start) is **unverified**. If it cannot, the validator fails closed and no RSS image post is produced until the worker runs somewhere that can. Workflow/Vercel settings were not changed in this checkpoint.

## B2 — still to do
DB claim guard (RPC refuses to claim/send an RSS sports post with no image) and structured auto skip reason (auto path currently returns `false`): new timestamped migration + `tests/db/` assertions; no production migration without approval.
