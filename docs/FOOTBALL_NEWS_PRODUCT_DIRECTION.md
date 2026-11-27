# Football News Control Center — approved product direction

Decision date: 2026-11-27. Product owner approved semantic event deduplication, Auto Publish dashboard, documentation synchronization, and structured skip/failure reasons. Football News Control Center takes priority over legacy ContentPilot AI coursework UX when requirements conflict.

## Proposed implementation (not yet delivered)
- Make Football News Control Center the primary authenticated experience; preserve existing content management, agent and human approval routes as secondary Content Studio tools where practical. Preserve authentication, workspace isolation and existing data.
- Provide Owner/Admin controls for publishing mode, bounded auto-publish window (existing maximum 8 hours), score threshold and posting quotas (currently 10 per two-hour slot, 40 per window), history and emergency stop. Enforce authorization and bounds in backend/database, not just UI. No secrets in browser. Do not activate auto-publishing by default.
- Semantic deduplication: compare event identity (participants, competition, event type/date) across sources; retain evidence and reasons; distinguish meaningful follow-up from duplicate; preserve URL/headline deduplication and protect concurrent runs.
- Expose workspace-scoped sanitized run and auto-delivery history through authorized read interfaces, not direct private schema access.
- Record structured reasons for missing image, crop error, expiry, quota, duplicate event, API failure, uncertain delivery and success. Separate skipped from failed in metrics.
- Synchronize README and sports-news architecture docs with deployed behavior; do not claim unverified external delivery or image rights.

## Release gates
Regression tests for legacy auth/workspaces/content/approval; cross-workspace authorization tests; semantic dedup fixtures; concurrency/quota/expiry tests; dashboard preview and mobile QA; verify production migration and deployment before claiming completion. Existing photo licensing and factual accuracy concerns remain open; they were not explicitly approved in this decision.
