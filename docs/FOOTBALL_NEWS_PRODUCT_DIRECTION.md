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

## Release gates
Regression tests for legacy auth/workspaces/content/approval; cross-workspace authorization tests; semantic dedup fixtures; concurrency/quota/expiry tests; dashboard preview and mobile QA; verify production migration and deployment before claiming completion. Dedicated photo-license verification and news fact-checking modules are explicitly out of scope for the current roadmap. This does not establish permission to reuse third-party imagery or certify news accuracy.
