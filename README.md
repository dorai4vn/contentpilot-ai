# ContentPilot AI

An agentic content workspace: users sign in, organise work into workspaces, and (from M3) delegate
real READ / CREATE / UPDATE operations on their data to an AI agent, with explicit human approval for
risky actions.

**Stack:** Next.js 16 (App Router, TypeScript, Tailwind CSS 4) · Supabase (PostgreSQL + Auth + Row Level
Security) · Vercel · Vitest · GitHub Actions.

## Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| **M1 — Foundation** | Next.js app, Supabase auth (email/password), protected dashboard, workspaces + RLS, `/api/health`, CI, Vercel-ready | ✅ code complete, awaiting cloud setup |
| M2 | Content data model (content items, drafts) | ⏳ |
| M3 | AI agent with READ / CREATE / UPDATE tools on stored data | ⏳ |
| M4 | Human approval / restricted permissions for risky agent actions | ⏳ |

## What M1 delivers

- **Real authentication** — sign-up, sign-in and sign-out with Supabase Auth (email + password). Session
  cookies are managed with `@supabase/ssr`; the session is refreshed in `src/proxy.ts`.
- **Server-protected dashboard** — `/dashboard` verifies the user on the server with `auth.getUser()`
  (`src/lib/auth/dal.ts`). The proxy redirect is only an optimisation, not the security boundary.
- **Workspaces in PostgreSQL** — the dashboard lists the user's workspaces and creates new ones. All
  queries run *as the user*, so Row Level Security decides what they can see and change.
- **`GET /api/health`** — runs a real query on Postgres (`public.health_check()`) and returns `200` with
  latency and server time, or `503` if the database is unreachable or not configured.

## Project structure

```
src/
  proxy.ts                    # Next 16 "proxy" (formerly middleware): session refresh + optimistic redirects
  app/
    page.tsx                  # Landing page
    (auth)/                   # /login, /signup, auth server actions, shared form
    auth/confirm/route.ts     # Email-confirmation landing route
    dashboard/                # Protected dashboard + create-workspace action
    api/health/route.ts       # DB connectivity probe
  lib/
    env.ts                    # Validated public Supabase config
    supabase/server.ts        # Per-request Supabase client acting as the user (RLS applies)
    supabase/proxy.ts         # Session refresh used by src/proxy.ts
    auth/dal.ts               # Data Access Layer: getCurrentUser / requireUser
    auth/routes.ts            # Protected routes + open-redirect-safe "next" handling
    workspaces/queries.ts     # Workspace reads/writes
    validation/auth.ts        # zod schemas for forms
    health.ts                 # Health-check logic
  types/database.ts           # DB types for the Supabase client
supabase/
  config.toml                 # Supabase CLI config (local stack)
  migrations/                 # SQL migrations — the source of truth for the schema and RLS
tests/
  db/                         # SQL tests for migrations + RLS (run on a disposable Postgres)
  e2e/smoke.cjs               # Browser smoke test against any deployment
scripts/test-db.sh            # Applies migrations to a throwaway DB and runs tests/db
```

## Database & security model

Migrations: `supabase/migrations/20261120000100_workspaces.sql`, `20261120000200_health_check.sql`.

- `workspaces(id, name, created_by, created_at, updated_at)` and
  `workspace_members(workspace_id, user_id, role)` with `role ∈ {owner, admin, member}`.
- **RLS is enabled on every table**; the `anon` role has no table privileges at all.
- Users only see workspaces they are members of; the creator automatically becomes `owner` (trigger).
- Only owners/admins can rename a workspace or manage members; only owners can delete a workspace or grant
  the `owner` role; admins cannot touch owners or promote themselves.
- A workspace can never lose its last owner; `created_by` and membership identity are immutable.
- Membership checks use `SECURITY DEFINER` helpers with an empty `search_path` that always use
  `auth.uid()` (no caller-supplied user id), avoiding recursive RLS.
- No service-role key is used anywhere in the app.

`tests/db/10_rls_workspaces.sql` asserts all of the above (35 checks).

## Local development

Requirements: Node.js ≥ 20.9 (22 recommended), npm, and either a Supabase cloud project or Docker for the
local Supabase stack.

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:3000
```

### Option A — local Supabase (Docker)

```bash
npx supabase start -x studio,imgproxy,storage-api,edge-runtime,logflare,vector,realtime,postgres-meta,supavisor,mailpit
```

This applies the migrations automatically and prints `API_URL` and `PUBLISHABLE_KEY`; put them into
`.env.local` as `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Email confirmation is
disabled locally (`supabase/config.toml`). If `ghcr.io` is blocked on your network, prefix the command with
`SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`.

### Option B — Supabase cloud project

See [Deployment](#deployment-supabase--vercel) steps 1–3.

## Scripts and checks

| Command | What it does |
| --- | --- |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript rules) |
| `npm run typecheck` | Generates Next route types, then `tsc --noEmit` |
| `npm test` | Vitest unit tests |
| `npm run build` | Production build |
| `npm run check` | All of the above |
| `npm run test:db` | Applies migrations to a **disposable** Postgres and runs the RLS tests (`TEST_DATABASE_URL`, or a throwaway local cluster if `initdb` is available) |
| `BASE_URL=… npm run test:e2e` | Browser smoke test (health, auth, protected dashboard, DB write, sign-out, isolation) |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests and build, plus the migrations + RLS tests
on a Postgres 17 service container, for every pull request.

## Deployment (Supabase + Vercel)

These steps need accounts that only the project owner can create; no credentials live in this repository.

1. **Create a Supabase project** at <https://supabase.com/dashboard> (free tier is fine).
2. **Apply the migrations** — either
   - SQL Editor: run `supabase/migrations/*.sql` in filename order, or
   - CLI: `npx supabase login`, `npx supabase link --project-ref <ref>`, `npx supabase db push`.
3. **Configure Auth** (Authentication → URL Configuration):
   - *Site URL*: your production URL, e.g. `https://contentpilot-ai.vercel.app`
   - *Redirect URLs*: `https://contentpilot-ai.vercel.app/**` and `https://*-<team>.vercel.app/**` for previews.
   - Email provider is on by default. Keep "Confirm email" enabled for production (users click the link,
     which lands on `/auth/confirm`). For a quick classroom demo you may disable it so sign-up logs in
     immediately. The built-in email sender is rate-limited; configure custom SMTP for real use.
4. **Import the GitHub repo in Vercel** (<https://vercel.com/new>) — framework preset *Next.js*, no
   build-setting changes needed.
5. **Set environment variables** in Vercel (Production and Preview):
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Project Settings → API Keys), and
   optionally `NEXT_PUBLIC_SITE_URL`. Redeploy after adding them.
6. **Verify the live site**:
   - `curl -i https://<your-app>.vercel.app/api/health` → `200` and `"connected": true`
   - `BASE_URL=https://<your-app>.vercel.app npm run test:e2e` (with `E2E_EMAIL`/`E2E_PASSWORD` of a
     confirmed account if email confirmation is enabled).

## How an instructor can test M1 on the deployed site

1. Open `/api/health` — JSON shows `"status":"ok"` and `"database":{"connected":true,…}`.
2. Open `/dashboard` while signed out — you are redirected to `/login`.
3. Create an account on `/signup` (confirm the email if required), then sign in.
4. Create a workspace on the dashboard — it appears with the **Owner** role and survives a reload and a
   re-login (stored in PostgreSQL).
5. Sign out, then sign up as a second user — the first user's workspace is not visible (RLS).
