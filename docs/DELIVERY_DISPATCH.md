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

GitHub Actions cron cannot run every minute (minimum 5 min, best-effort), and workflow files were out of scope.
Proposed separate workflow `.github/workflows/sports-delivery.yml` for owner review:

```yaml
name: Sports delivery fallback
on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch:
permissions: {}
concurrency:
  group: sports-delivery
  cancel-in-progress: false
jobs:
  deliver:
    if: ${{ vars.SPORTS_NEWS_CRON_URL != '' }}
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - name: Deliver approved items only
        env:
          CRON_URL: ${{ vars.SPORTS_NEWS_CRON_URL }}
          CRON_SECRET: ${{ secrets.SPORTS_NEWS_CRON_SECRET }}
        run: |
          curl --silent --show-error --fail-with-body --proto '=https' --max-time 120 \
            --request POST --header "Authorization: Bearer ${CRON_SECRET:?}" "${CRON_URL:?}?mode=deliver"
```

Prerequisites: this PR deployed; existing `SPORTS_NEWS_CRON_URL` var must be the bare route URL without a query string
(otherwise adapt the `?mode=deliver` append); the existing worker env vars. A true every-minute schedule needs an
external scheduler (e.g. Vercel Cron on a Pro plan, which sends GET and would need a GET handler added) — not applied.
