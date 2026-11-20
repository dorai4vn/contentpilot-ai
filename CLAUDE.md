@AGENTS.md

# ContentPilot AI — guide for Claude / coding agents

Academic "Agentic App": Next.js 16 App Router + Supabase (Postgres, Auth, RLS), deployed on Vercel.
Final product must have: real login + Postgres backend, an AI agent doing real READ/CREATE/UPDATE on stored
data (M3), and risky agent actions gated by human approval or restricted permissions (M4).

## Working environment

- Development happens in ephemeral Claude Code cloud sessions. Nothing on the local disk persists:
  **commit and push every finished change** to a feature branch. Never rely on local DBs or `.env.local`.
- Never commit secrets. `.env*` is git-ignored except `.env.example`. No credentials in code, tests or docs.

## Commands

- `npm run check` — lint + typecheck + unit tests + build (run before every commit).
- `npm run test:db` — migrations + RLS tests on a disposable Postgres (never a real project).
- `BASE_URL=… npm run test:e2e` — browser smoke test against a running app.
- Local Supabase: `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io npx supabase start -x studio,imgproxy,storage-api,edge-runtime,logflare,vector,realtime,postgres-meta,supavisor,mailpit`
  (start `dockerd` first in a cloud session; ghcr.io blobs are blocked by the proxy there).

## Next.js 16 specifics (differs from older training data)

- `src/proxy.ts` replaces `middleware.ts` (export `proxy`, Node runtime).
- `cacheComponents` is deliberately **off** (`next.config.ts`): pages render at request time.
- `params` / `searchParams` / `cookies()` / `headers()` are async. Use generated `PageProps<"/route">` types.
- Read `node_modules/next/dist/docs/` before using unfamiliar APIs.

## Architecture rules

- Data access goes through `src/lib/**` (server-only). Pages/actions call `requireUser()` from
  `src/lib/auth/dal.ts` first — Server Actions and Route Handlers are public endpoints.
- Use `createClient()` from `src/lib/supabase/server.ts` (acts as the user, RLS applies).
  **Do not use the service-role key** to bypass RLS; if elevated access is ever needed, use a narrowly
  scoped `SECURITY DEFINER` SQL function with explicit checks, and document it.
- Schema changes = new timestamped file in `supabase/migrations/` (never edit applied migrations), update
  `src/types/database.ts`, and add assertions to `tests/db/`. Every new table: RLS enabled + policies +
  revoke from `anon` unless it must be public.
- Validate all input with zod (`src/lib/validation`). Return generic error messages; never leak DB errors.
- Redirect targets from user input go through `safeRedirectPath()`.
- Never fake API responses, DB access or auth. Test doubles are allowed only inside unit tests.

## Milestone discipline

- M1 (done): foundation. M2: content data model. M3: AI agent tools (READ/CREATE/UPDATE).
  M4: approval workflow for risky actions. Do not start a later milestone's features early.
- Do not claim deployment works until the live URL has been tested (`/api/health` + e2e smoke test).
