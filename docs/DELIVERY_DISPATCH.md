# Approved-delivery dispatch (Issue #26)

## Architecture found

- `approve_publish_request` only **queues** a row in `publish_deliveries` (`status='queued'`, `attempt_count=0`).
- Sending happens only in the worker (`src/lib/sports-news/worker.ts`): `claim_social_deliveries` (max 6 rows/call,
  `FOR UPDATE SKIP LOCKED`, status → `sending`) → adapter publish with the row's `idempotency_key` →
  `finish_social_delivery` (`succeeded` / `failed`).
- Before this change the worker ran only inside `POST /api/cron/sports-news`, together with the RSS crawl, scheduled
  every 2 hours by `.github/workflows/sports-news.yml`. That is why approved items waited up to 2 hours.

## What changed (no schema/RPC change, no migration)

1. `runSportsDelivery()` (worker.ts): delivery-only run. No RSS, no LLM, no drafting, no approval. Same claim/finish RPCs,
   same adapter and same auto-publish-window exclusion as the full run. Bounded: at most `DELIVERY_MAX_ROUNDS` (5)
   rounds × 6 claims and a 100 s budget; `truncated: true` is reported if more remain (they stay `queued`).
2. `POST /api/cron/sports-news?mode=deliver`: same `CRON_SECRET` bearer auth as the existing route, runs only
   `runSportsDelivery`.
3. Prompt dispatch: after a committed human approval (single or bulk) that queued an external delivery, the server action
   schedules `dispatchApprovedDeliveries(workspaceId)` with `after()`. It runs only for the configured worker workspace,
   uses worker credentials from server env only, coalesces concurrent calls in-process, never throws, and logs only safe
   fields. Approval result is unaffected if dispatch fails: the item stays `queued` for the scheduled run.

## Status semantics (unchanged, accurate)

- `queued`: approved, not yet claimed. `sending`: claimed (attempt in progress).
- `succeeded`: provider returned an external id. `failed` + `last_error_code`: provider error (`rate_limited` is retried
  with backoff up to 4 attempts).
- Uncertain: a `sending` row older than 5 min (crash/timeout) becomes `failed` with `delivery_unconfirmed`
  and is **never replayed automatically**, because the provider may already have posted it.
- No double send: only one claimer gets a row (`SKIP LOCKED`), rows leave `queued` on claim, adapters get a stable
  `idempotency_key`.

## Fallback schedule (NOT applied; needs owner action)

Uses the existing Supabase `pg_cron` + `pg_net` architecture (see `docs/architecture/sports-news.md`), every minute,
with the existing Vault secret `contentpilot_sports_news_cron_bearer` (no plaintext secrets, no new service).
Exact idempotent setup / verify / rollback SQL: [`docs/ops/sports-delivery-cron.sql`](ops/sports-delivery-cron.sql).

- **Cheap queue-due check**: the cron command only calls `net.http_post` when `publish_deliveries` has a sendable row
  (`queued`/`failed`, `next_attempt_at <= now()`, `attempt_count < 4`, destination `active` and not `internal`; the same
  predicate as `claim_social_deliveries`). Idle minutes make zero HTTP calls and zero Vercel invocations. No schema change.
  The check is not workspace-scoped and does not know about the auto-publish window; the worst case is one no-op call,
  because the route itself is bound to the configured worker workspace and leaves a window-owned destination alone.
- **Route auth**: `POST /api/cron/sports-news?mode=deliver` requires `Authorization: Bearer $CRON_SECRET`
  (constant-time compare, 401 otherwise). Workspace binding comes from worker env + `can_run_news` inside the RPCs.
- **Overlap / concurrency**: `net.http_post` is asynchronous, so a slow run never blocks the next minute; overlapping runs
  and the post-approval `after()` dispatch cannot claim the same row (`FOR UPDATE SKIP LOCKED`, status leaves `queued`).
- **Bounded runtime**: scheduled run ≤ 5 rounds × 6 rows and a 100 s budget inside the route's `maxDuration = 180`;
  pg_net timeout is 70 s (the HTTP request may be abandoned by pg_net, the route still finishes and claims stay safe).
  Post-approval `after()` dispatch uses a 40 s budget, and the pages that host the approval actions export `maxDuration = 60`.
  Anything left over stays `queued` and the next minute continues. 8 approvals = 2 claim rounds.
- **Retries / uncertain**: 429 → `failed` with backoff and up to 4 attempts; a `sending` row older than 5 min (function killed
  mid-send) becomes `failed/delivery_unconfirmed` and is never replayed automatically.
- **Auto-publish exclusion**: while a temporary auto-publish window owns the Telegram destination, the delivery run does
  not touch that destination (unit-tested).

### Deployment order

1. Merge/deploy this PR to Production (route `?mode=deliver` + dispatch). Confirm `CRON_SECRET`, worker env vars and the
   Vault secret already exist (they do for the 2-hourly job).
2. Verify the route without sending anything: an unauthenticated `POST ...?mode=deliver` must return 401.
3. Only then run the SETUP block of `docs/ops/sports-delivery-cron.sql` (the owner, in the SQL Editor).
4. Keep the 2-hourly `contentpilot-sports-news` job unchanged.

### Safe production verification (no test posts)

- Read-only SQL in the VERIFY block: job is active, `cron.job_run_details` succeed, `net._http_response` shows 200, and
  `publish_deliveries` queued count drains. With an empty queue, expect no `net._http_response` rows at all.
- Do not create test approvals in Production; the next real approval is the verification (status goes
  `queued` → `sending` → `succeeded` with an external id within about a minute).
- Rollback: `select cron.unschedule('contentpilot-sports-delivery');`.

The earlier GitHub Actions proposal is superseded (Actions cannot run every minute).
