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

### A3a — runtime feasibility (measured 2026-11-28, GitHub-hosted runner, Node 22, 4 vCPU/16 GB)
**Evidence**
- Entrypoint: `POST /api/cron/sports-news` (Node runtime, `maxDuration = 180`, Bearer `CRON_SECRET`). `sports-news.yml` only `curl`s it every 2 h (`--max-time 200`, job timeout 4 min). The QC model therefore runs inside the Next.js (Vercel) function. No `vercel.json`; no Vercel settings were read or changed.
- **Bug found and fixed:** `next build` file tracing (`route.js.nft.json`, 330 files, ~88 MB, mostly sharp libvips glibc+musl) includes `onnxruntime_binding.node` but NOT `libonnxruntime.so.1` (21 MB, dlopen'd). Copying only the traced files to an empty dir and `require('onnxruntime-node')` => `ERR_DLOPEN_FAILED`. In production this would have meant `model_unavailable` on every candidate => fail closed => no RSS image posts. Fix: `outputFileTracingIncludes` for `/api/cron/sports-news` only, adding `onnxruntime-node/bin/napi-v3/linux/x64/**`. After rebuild the traced-only copy loads (`loaded 8` exports; traced onnxruntime-node 43 MB). Unit test: `runtime-config.test.ts`.
- Not yet proven: a full traced copy running the real model (only the native lib load was proven in the traced copy; the real-model smoke ran from the full `node_modules`). Total function size is ~88 MB + ~21 MB native, before the model.
- Model: `scripts/fn11-runtime-smoke.mjs` (synthetic green image, NOT a visual QC): cold load incl. 204 MB download 1.6 s, warm load 0.55 s, inference 75-93 ms, RSS ~620-630 MB on this runner. Download speed from Hugging Face on Vercel is unmeasured.
- Writable cache: default `os.tmpdir()/contentpilot-siglip` (`SPORTS_IMAGE_MODEL_CACHE` overrides). Vercel functions only have writable `/tmp` (ephemeral, per instance), so each cold instance re-downloads ~204 MB; the in-process verdict cache is not shared across instances.
- Memory/timeouts: ~0.63 GB RSS fits typical function memory but the plan's actual limit was not verified. Worst case per run is bounded by 5 candidates x 25 s QC timeout (`SPORTS_IMAGE_QC_TIMEOUT_MS`) which can exceed the 180 s `maxDuration`; A3b must add a total candidate budget. Concurrency: workflow `concurrency: sports-news` (cancel-in-progress false) serialises scheduled runs, but the route itself has no lease; overlapping invocations (manual curl, `deliver` mode) would each load the model.
- **Preview-only smoke on Vercel: NOT DONE / unavailable** (no Vercel access in this task; production cron must not be triggered). Vercel feasibility is therefore NOT a pass; it is "unverified, one blocking bug fixed".

**Vercel vs GitHub Actions for the RSS/QC worker (no extra hosting purchase)**
| | Vercel function (current) | GitHub Actions job |
|---|---|---|
| Native ONNX/sharp | needs tracing fix above; bundle ~110 MB + 204 MB download per cold instance, unverified | `npm ci` + actions/cache for the model; measured OK here |
| Time limit | `maxDuration` 180 s (plan limit unverified) | job up to 6 h; set ~10 min |
| Memory | plan-dependent, unverified | 16 GB (public) / 4 vCPU |
| Auth/secrets | existing `CRON_SECRET` and server env; DB via user-less path as today | would need Supabase + Telegram secrets in Actions = new secret scope; run only on trusted `main`/schedule, `environment` protection, never on PRs/forks |
| Single scheduler / lease | workflow curl + serial concurrency group | same group, plus DB lease needed so Vercel and Actions never both run |
| Off / emergency stop / quotas / dedup / FN10 retention | all enforced in `worker.ts`/DB (unchanged) | same code would run, but a second runtime duplicates env config |
| Retries | next 2 h cron tick | same, plus job-level retry |
| Minutes | ~0 extra (curl <1 min) | est. install ~10 s with cache + model 10-60 s cold (cached ~0 s) + RSS fetch/QC; ~2-4 min/run x 12 runs/day ≈ 24-48 min/day, ~0.7-1.5 k min/month (count depends on repo visibility/plan; not asserted free) |

**Recommended design (not implemented; needs owner approval, touches workflows/secrets):** keep Vercel as the single orchestrator now with the tracing fix and fail-closed behaviour; before enabling any live RSS image posting, run a preview-only smoke with a synthetic image to prove the traced bundle + `/tmp` download + memory. If that fails or exceeds limits, split QC out: Actions job (trusted `main`, schedule/dispatch only, `actions/cache` for the model, secret scope limited to read candidate + write verdict) or run QC in the Actions job and have the Vercel route only deliver verified rows. Either way the B1 gate keeps "no image => no send".

### A3b — entity matching, topic prompts, budgets, isolation (policy `fn11-a3b.1`)
- `image-entities.ts`: typed club/national-team/competition aliases (whole-word, accent-folded; ambiguous aliases such as "anh", "mu", "forest" alone were deliberately left out), topic detection (match/portrait/press_conference/transfer/injury), multi-word person names. Hint naming a different known club than the title => `entity_conflict` **even for article-embedded images** (article provenance is no longer unconditional proof). Non-article sources (Wikimedia, search) need a typed match; one shared generic token is `not_corroborated`.
- Topic-aware prompts: person-centred topics use kit/press-conference/signing/injury positives and drop the "portrait not playing sport" negative. Limitation: the model cannot identify WHICH person; portraits rely on provenance/hint corroboration.
- Scores: NaN/Infinity/out-of-range/missing labels => `invalid_scores` (fail closed).
- `image-budget.ts`: ONE budget per article (<=5 candidates combined article + search + Wikimedia, 90 s scan budget). Worker skips Wikimedia when exhausted.
- Isolation: inference is serialised; a timed-out ONNX run (not cancellable) keeps the model `model_busy` until it truly settles, so no overlapping runaway inference.
- Tests: unit tests use MOCK scorers/models (wiring only, not visual QC).
- **Benchmark status (honest):** harness extended (`FN11_BENCH_DIR`, per-item `split: calibration|holdout`, confusion counts per split, p50/max latency, peak RSS). The expanded real-image set (stadium/logo/wrong-team/youth mismatch, portrait/press/transfer positives, prior homonyms) was **NOT collected or run in this checkpoint**; no new false accept/reject numbers are claimed. A2 figures (n=27, 0 false accepts, calibration only, no holdout) still stand as the only real-model data.
- **Safe isolated preview smoke plan (for later independent verification, not run):** (1) Vercel *Preview* deployment of this branch with a separate throwaway Supabase project/disposable DB, no Telegram/social credentials, `CRON_SECRET` preview-only; (2) call only the preview URL of a new/guarded smoke route or `scripts/fn11-runtime-smoke.mjs` with a synthetic image; never the production URL or production cron; (3) record cold download time to `/tmp`, RSS, duration vs `maxDuration`, traced bundle size; (4) automation mode must be Off and no deliveries enabled; (5) PASS only if model loads from the traced bundle and returns finite scores.

## B2 — still to do
DB claim guard (RPC refuses to claim/send an RSS sports post with no image) and structured auto skip reason (auto path currently returns `false`): new timestamped migration + `tests/db/` assertions; no production migration without approval.
