# Football News Control Center — approved product direction

Decision date: 2026-11-27. Product owner approved semantic event deduplication, Auto Publish dashboard, documentation synchronization, and structured skip/failure reasons. Football News Control Center takes priority over legacy ContentPilot AI coursework UX when requirements conflict.

## Proposed implementation (not yet delivered)
- Make Football News Control Center the primary authenticated experience; preserve existing content management, agent and human approval routes as secondary Content Studio tools where practical. Preserve authentication, workspace isolation and existing data.
- Provide Owner/Admin controls for publishing mode, bounded auto-publish window (existing maximum 8 hours), score threshold and posting quotas (currently 10 per two-hour slot, 40 per window), history and emergency stop. Enforce authorization and bounds in backend/database, not just UI. No secrets in browser. Do not activate auto-publishing by default.
- Semantic deduplication: compare event identity (participants, competition, event type/date) across sources; retain evidence and reasons; distinguish meaningful follow-up from duplicate; preserve URL/headline deduplication and protect concurrent runs.
- Expose workspace-scoped sanitized run and auto-delivery history through authorized read interfaces, not direct private schema access.
- Record structured reasons for missing image, crop error, expiry, quota, duplicate event, API failure, uncertain delivery and success. Separate skipped from failed in metrics.
- Synchronize README and sports-news architecture docs with deployed behavior; do not claim unverified external delivery or image rights.

## UI and theme requirements (approved 2026-11-27)
- Modern SaaS dashboard, desktop-first with responsive mobile workflows; prioritize Football News Control Center over coursework UX.
- Full Light and Dark modes, plus System preference as a proposed default. Provide a visible theme selector and persist user preference across navigation and reloads.
- Use semantic design tokens for backgrounds, surfaces, text, borders, focus, status colors and charts. Ensure readable contrast (WCAG AA target), including tables, forms, dialogs, badges, loading/empty/error states and legacy Content Studio routes where retained.
- Verify both themes at desktop and mobile widths, including keyboard navigation, chart readability and absence of theme flash/hydration mismatch.

## Scoring configuration (2026-11-27)
- Owner/Admin can set the qualifying RSS score threshold (0–10, step 0.1) directly in the Automation screen. Default 8. Persist per workspace/project, enforce server-side, apply on the next scan without redeployment.
- Proposed advanced control: editable reach/importance/freshness weights, default 45/40/15, each nonnegative, sum exactly 100; reset defaults and preview sample scores. Version each configuration and retain the effective weights, threshold and component scores for every decision. Never silently rescore historical decisions.
- Expose strict threshold mode (no qualifying story means no post); existing highest-below-threshold fallback must be explicit and must not automatically publish below the configured minimum in strict mode. Test boundary values, invalid totals, permission isolation and consistent worker behavior.
- Functional-first UI: simple reusable components, no ornamental neon, stadium backgrounds or glassmorphism; prioritize real data and responsive light/dark controls.

## Design System V1.0 — Premium Sports SaaS (approved 2026-11-27)
- Approved visual direction: 60% Premium SaaS, 40% Sports Editorial. Functional first: expressive but restrained, not a generic minimal admin panel or a neon sports/game interface.
- Light tokens: background #F1F5F4, surface #FFFFFF, primary #087F5B, accent #D6F5E5, text #152B27. Dark tokens: background #101820, surface #1B2632, primary #34D399, accent #193D34, text #F1F5F9. Validate contrast for all token pairings before release.
- Proposed implementation defaults: Inter typography, Lucide icons, 8–12px radii, restrained shadows, 150–200ms transitions honoring reduced motion. Reuse Next.js/Tailwind and existing components; avoid unnecessary dependencies.
- Use football imagery in article cards, not dashboard backgrounds. No neon, glassmorphism, decorative stadium backgrounds or fabricated KPIs. Use clear hierarchy, restrained accent colors and only useful charts.
- Prioritize six screens: Overview, News Feed, Automation (including scoring configuration), Review Queue, Activity Logs, Settings. Retain legacy Content Studio as secondary navigation. Desktop-first, responsive mobile, Light/Dark/System with persisted preference.
- Deliver working backend and real data before visual polish. QC both themes, mobile controls, accessibility and regression behavior before production release.

## Three-mode automation control — FN08 (owner-approved 2026-11-28)
- **Auto**: persistent (no expiry) until the mode changes. **Semi**: RSS, scoring, dedup, caption and image run automatically; a human approves the exact version before delivery. **Off**: no RSS, AI, image processing or delivery; checked before every external call, in-flight work stops at safe checkpoints.
- 2h cadence, **distinct eligible posts per RSS scan / delivery slot are configurable (FN09: default 2, 1–10; was 3 in FN08, 10 before);** Daily Limit default 20 and Scan Interval default 2h (2–24h) are also configurable — see docs/ops/auto-post-cadence.md ( the assessment candidate budget of 20 and draft-call budget of 10 are separate from this output cap), configurable daily quota (1–120, Asia/Dubai day), score configuration, dedup and delivery idempotency are unchanged. Auto permits `unresolved_identity`, `uncertain_facts`, `follow_up` and `reconsidered` without manual approval; confirmed duplicates stay blocked. No independent fact checking; test mode stays isolated.
- Migration `20261128090000_sports_automation_modes.sql`: no mode row means **Off** (fail safe: nothing starts RSS/AI/delivery until an Owner/Admin chooses Semi or Auto). Only Owner/Admin may change the mode (`set_sports_automation_mode`); every transition is audited. Switching modes never replays backlog: Auto only delivers drafts created after it was enabled.
- The legacy temporary window control remains for Semi and is rejected while Auto/Off. Emergency Stop switches to **Off**. Already-approved queued deliveries resume when the mode is Semi/Auto.
- Selection: all stories scoring ≥ threshold (default 8), ranked descending, up to the configured Posts per Scan (FN09 default 2, range 1–10; see docs/ops/auto-post-cadence.md); if none qualifies the single highest eligible story (`highest` fallback; `strict` selects none). Daily quota is unchanged.
- Scoring V2 (`sports-v2`, migration `20261128120000_automation_default_off_scoring_v2.sql`): Popularity 30% · Importance 25% · Recency 25% (source publication time) · Engagement 20% (inherent discussion/share potential from the same assessment call; no extra AI call, no invented controversy). Explicit custom configurations keep their weights (engagement 0); rows still on the old 45/40/15 default move to 30/25/25/20; historical scores are untouched.
- The migrations have NOT been applied to production; that needs separate owner approval.

## Release gates
Regression tests for legacy auth/workspaces/content/approval; cross-workspace authorization tests; semantic dedup fixtures; concurrency/quota/expiry tests; dashboard preview and mobile QA; verify production migration and deployment before claiming completion. Dedicated photo-license verification and news fact-checking modules are explicitly out of scope for the current roadmap. This does not establish permission to reuse third-party imagery or certify news accuracy.
