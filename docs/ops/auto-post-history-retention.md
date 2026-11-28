# FN10 — Auto Post operation history retention

**Visible:** Auto Post → *Lịch sử thao tác* shows the **5 newest** events per workspace/project, newest first
(`created_at desc, seq desc`; `seq` is a monotonic tie-break, so equal timestamps are deterministic).
**Hidden:** older rows get `hidden_at` (server-side) and are **not** deleted immediately.
**Purged:** a hidden row is deleted once `hidden_at <= now() - 30 days` (retention counts from the moment it was hidden,
never from `created_at`). The latest five are retained indefinitely, whatever their age.
Only `contentpilot_private.sports_automation_events` is affected — publishing history, delivery logs
(`publish_deliveries`, `sports_auto_publish_*`, `content_publish_request_events`) and other audit tables are untouched.

## Mechanism

* **Ranking (atomic):** an `AFTER INSERT` trigger calls `contentpilot_private.rank_sports_automation_events(ws, project)`,
  which takes `pg_advisory_xact_lock` on the scope, then sets `hidden_at` for rows ranked > 5 (kept if already set) and
  clears it for rows inside the top 5. Concurrent inserts are serialised per scope; the later transaction re-reads
  committed rows, so exactly five stay visible (tested with 72 parallel inserts on PG 17.12).
* **Purge:** `public.purge_sports_automation_history(ws, project)` — worker-only (`can_run_news`, same as
  `begin_sports_scan`), real clock only, scoped to one workspace/project, never deletes a row inside the newest five.
  `contentpilot_private.purge_sports_automation_events(ws, project, now)` is not callable by any API role (used by tests
  to check the exact 30-day boundary).
* **Cadence:** the existing GitHub scheduler (`.github/workflows/sports-news.yml`, `0 */2 * * *`) calls the cron route;
  `runSportsNews` / `runSportsDelivery` call the purge **first, before the Off check**, so cleanup runs every 2 h
  regardless of Auto Post mode (Off/Semi/Auto). It is best-effort (a failure never fails a run), makes no RSS, AI,
  Telegram or other external call, and needs no new workflow, secret, extension (`pg_cron`) or Vercel setting.
  Caveat: cleanup only happens while the existing scheduler runs (`SPORTS_NEWS_CRON_URL` set); hidden rows are invisible
  to users either way, so a stopped scheduler only delays storage reclamation.

## Migration plan — `20261128180000_automation_history_retention.sql`

1. Adds `hidden_at` and `seq` (+ sequence, indexes), the trigger, the two functions, and replaces
   `list_sports_automation_events` (same columns, `limit 5`, hidden rows excluded).
2. **Backfill:** existing rows get `seq` in `(created_at, id)` order. Preexisting rows beyond the newest five per scope get
   `hidden_at = migration time` (no reliable historical hide time exists), so their 30 days start at migration and
   **nothing is deleted by the migration**. The newest five stay visible even if old. Covered by
   `tests/db/hooks/before_20261128180000_*.sql` + `tests/db/92_automation_history.sql`.
3. Rollout (after owner approval, not done by this PR): apply the migration to Production, then deploy the app. Order is
   safe either way: the new app tolerates a missing purge RPC (best-effort), the old app works with the new list function.
   Rollback: drop the trigger/functions and restore the previous `list_sports_automation_events` (20 rows); the added
   columns are harmless to leave.
4. Test-only change: the two "Off makes zero calls" unit tests now allow exactly one DB call, the retention RPC
   (`purge_sports_automation_history`), and still forbid every other call.
