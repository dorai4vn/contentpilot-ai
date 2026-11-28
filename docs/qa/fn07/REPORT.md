# FN07 — Regression & UI QA (FN08 candidate)

- **Tested SHA:** `67dff1ac83c164ec2ac36bd710bc6d712df16d58` (PR #43 head, FN08). Baseline for comparison: `main` = `44ebaf3`.
- Environment: Node 22.23.5, PG17.12 (Docker, disposable) and local Supabase (disposable), Chromium 153 (Playwright 1.63). Offline: no RSS, Telegram, OpenAI or production access.
- Logs: `logs/`. Screenshots: `screenshots/`. SQL probe: `fn07_backlog_off.sql`.

## Results
| Check | Result |
|---|---|
| `npm run check` (lint, typecheck, 61 files / 1150 unit tests, build) | PASS |
| `npm run test:db` on PG17 (526 assertions + concurrency) | PASS |
| `npm run test:db` on PG18.7 | FAIL in `20_content_management.sql:395` (23001 vs 23503) — PG18 difference, not FN08 (see D1) |
| E2E smoke, bulk-approval | PASS as shipped |
| E2E content, agent-ui, approval-ui, profiles | FAIL as shipped on both FN08 and main (stale path, D2); PASS after path-only fix (included here) |
| New `fn07-qa.cjs` (105 checks) | PASS: auth isolation, default Semi, transitions + audit, quota 0/1/120/121/-5/1.5, Emergency Stop, theme persistence/System/no flash/hydration, 3 viewports × 2 themes × 6 pages, keyboard, token contrast |

## Findings (no policy or application code changed)
- **D1 (test infra, low):** `test:db` fails on PostgreSQL 18 (`restrict_violation` 23001). Same on main. CI uses PG17.
- **D2 (stale tests, medium for CI value):** legacy E2E suites open `/w/<id>` and expect Content Studio controls, which moved to `/w/<id>/studio` (FN05/redesign). Fails identically on main. Fixed here by path-only edits (no assertions weakened).
- **R1 — Semi default / migration order (HIGH, deploy risk):** `readAutomationMode` is fail-closed: an RPC error is treated as **Off**. If the FN08 worker code runs before `20261128090000_sports_automation_modes.sql` is applied to production, `get_sports_automation_mode` does not exist, so the scheduled worker (`sports-news.yml`, every 2h) returns `automation_off` and stops RSS **and human-approved delivery** silently. Apply the migration before merging/deploying FN08 (needs separate owner approval). After migration the absent row reads as Semi (verified by DB test and UI: nothing written on page view, no silent Auto). A legacy temporary window still open at migration time survives and keeps working in Semi until it expires; the first mode save closes every open window.
- **R2 — Emergency Stop = Semi (MEDIUM, expectation):** works as documented (closes the persistent window, Auto→Semi, audited, button only shown in Auto). But Semi still runs RSS, scoring and AI/caption/image calls, so it stops *publishing*, not *spend*. Owners wanting zero external calls must use Off. Consider UI copy pointing to Off.
- **R3 — Off is destination-scoped in the database (MEDIUM):** `claim_social_deliveries` blocks only the destination stored in the mode row (Telegram). In the PG17 probe, with mode Off an approved Discord delivery in the same workspace **was claimed**; Telegram was blocked. In production the worker returns before claiming when Off, so this is a defence-in-depth gap, not an observed leak; docs say "no delivery".
- **R4 — Approved backlog (INFO):** Off keeps approved deliveries `queued` (not lost). On Off→Semi they are claimed again (probe: 3 approved Telegram deliveries returned, including older fixture rows); the DB has no age limit. Only the worker's `sportsArticleIsCurrent`/`stale_article` check skips articles from a previous day. Same-day approved posts resume automatically. Auto never replays drafts created before it was enabled (DB test + probe).
- **U1 — Mobile navigation (LOW):** at 390px "Tự động hóa", "Nội dung", "Trợ lý AI" are reachable only by horizontal scroll of the nav strip, with no scroll hint (see `screenshots/mobile-*`). No page-level overflow anywhere.
- **U2 (INFO):** the audit log also records no-op transitions such as SEMI → SEMI (quota-only saves).
- **Charts:** the candidate contains no chart/SVG components, so chart readability is not applicable.
- **Off zero external calls:** verified at unit level (worker/auto-delivery tests with injected doubles: Off before RSS fetch, before AI, before delivery; fail-closed on RPC error) and at DB level (Off rejects drafts with CP411, no claim). Not verified end-to-end with a live worker process against RSS (offline constraint).

## Not covered / blockers
- Repeat after any further FN08 commit (SHA-pinned) and before release.
- FN08 migration NOT applied to production; no production checks performed.
- Hydration was checked via console warnings and class mutation logs, not a visual-diff tool.
