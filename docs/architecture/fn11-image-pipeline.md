# FN11 image pipeline (A1 acquisition → A2 validation → B gate)

## A1 — acquisition (`src/lib/sports-news/image-acquisition.ts`)
- Candidates in order: RSS media (`media:content`/`media:thumbnail`/image `enclosure`), `og:image`, `twitter:image`, JSON-LD `image`, first lead `<img>`; at most 5 tried per article (bounded substitution).
- Article hosts: built-in Vietnamese football sites plus `SPORTS_IMAGE_ALLOWED_HOSTS` (comma-separated public official club/league/fanpage hosts; no private/login-only hosts). Image hosts must be in the same policy.
- Safety: https only, no port/credentials/IP literal, DNS answers must be public, manual redirects (max 3) re-validated each hop, 8 s timeout, HTML ≤1 MB, image ≤5 MB, MIME + magic-byte signature + sharp-decoded format, 400–8000 px sides.
- Heuristic rejection (URL/alt text only): logo, icon, banner, placeholder, flag, painting, street, building, basketball, …
- Optional `ImageSearchProvider` adapter exists; **no provider is bundled or called**. Its candidates still pass the host allowlist. No paid API is used.
- Every result carries provenance and `verification: "metadata_only"`, `visualQc: "pending_a2"`. Metadata/OG/filename is NOT visual verification and never counts as a final QC pass.

## A2 — visual relevance (design, not implemented)
Fail-closed validator between A1 and storage: a vision model (or human) answers "does this image show the entities/event of the article (right teams/players/age group, recent, not logo/building/artwork/generic stadium)". Input: image + title + entities; output: `pass|reject` + reason. Without a configured validator the result stays `pending_a2` and must not be shown as PASS. Provider availability: none configured in this repo; the existing Claude draft model is vision-capable but each call is paid app AI → needs separate owner approval and a bounded dry-run budget (≈1 call per candidate, ≤5 per article, ≤3 posts/run).

## B2 — still to do
DB claim guard (RPC refuses to claim/send an RSS sports post with no image) and structured auto skip reason (auto path currently returns `false`): new timestamped migration + `tests/db/` assertions; no production migration without approval.
