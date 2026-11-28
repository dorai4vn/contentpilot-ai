# FN09 — Configurable Auto Post cadence

Owner-approved defaults (Asia/Dubai day, Off by default): **Daily Limit 20 / day**, **Scan Interval 2 h**,
**Posts per Scan 2** (total distinct posts across *all* RSS sources, not per source). Editable by Owner/Admin in
*Social Automation → Auto Post*; persisted per workspace/project in `contentpilot_private.sports_automation_modes`.

## Bounds (validated in zod, the RPC and table CHECKs)

| Setting | Range | Why |
|---|---|---|
| Daily Limit | 1–120 (unchanged) | existing range; hard publishing cap, not a target |
| Scan Interval | 2–24 h, whole 2 h steps | the GitHub scheduler ticks every 2 h (`0 */2 * * *`); a shorter or non-multiple interval cannot be honoured |
| Posts per Scan | 1–10 | the separate AI draft-call budget is 10 (`SPORTS_NEWS_DRAFT_CALL_BUDGET`) |

Unchanged: threshold 8, weights 30/25/25/20, highest fallback, candidate fetch/assessment budgets (separate from the
output limit), dedup across all feeds before selecting at most N distinct posts.

## Enforcement (not labels)

* **Scan interval** — `begin_sports_scan()` (worker-only, row-locked) is called before any RSS/AI/image work. It returns
  `due=false` for Off/unconfigured projects, and when `now < last_scan_at + interval − 10 min` (scheduler jitter). Of N
  concurrent ticks exactly one gets `due=true`. A not-due tick still runs delivery-only for already approved posts.
  Manual test runs (`testDate`) never touch the cadence. No extra paid AI call is made by changing settings.
* **Posts per scan** — passed to `selectSportsNews`, and re-enforced in `claim_sports_auto_publish` (slot width =
  interval, cap = posts per scan, read from the mode row).
* **Daily Limit** — `claim_sports_auto_publish` counts today's deliveries (Asia/Dubai) against `daily_quota`.

## Changing settings safely

* Saving in the same mode (Auto → Auto) updates the open persistent window **in place**: no new window, no backlog
  replay, drafts created since Auto was enabled stay eligible. Changing mode keeps the existing semantics (fresh window).
* Interval changes never reset `last_scan_at`: shortening applies from the last real scan on the next tick; lengthening
  delays the next scan to `last_scan_at + new interval`. Toggling Off→On does not buy an extra scan.
* Lowering the Daily Limit or Posts per Scan applies immediately to new claims; nothing already sent is touched.
* Emergency Stop = Off; it keeps the configured values.

## Migration `20261128150000_automation_cadence_settings.sql`

Adds `scan_interval_hours` (default 2), `posts_per_scan` (default 2), `last_scan_at` to the mode table and the two
columns to the audit log; `daily_quota` column default becomes 20. **Existing rows keep their `daily_quota`
untouched.** An old default 40 and an explicit 40 are *indistinguishable* (the form always submitted a value and no
"explicit" marker was ever stored), so no row is rewritten — 40 stays 40; owners can lower it in the UI. Unconfigured
projects display 20/2h/2. Existing rows receive 2 h/2 posts (previously fixed constants 2 h/3 posts, never customizable);
open persistent Auto windows are tightened to 2 per slot. Not applied to production — requires separate owner approval.
