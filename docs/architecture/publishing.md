# Publishing architecture

ContentPilot AI will publish content to several platforms (internal site first,
later Telegram, Discord, Facebook and others). This document is the long-term
design every publishing change must follow. It was approved for M4.6 and applies
to all later milestones.

Status: **M4.6a** implemented the database foundation
(`supabase/migrations/20261121120000_publishing_destinations.sql`) and **M4.6b**
the application layer (data access, Publisher Adapter, registry, UI). Only the
`internal` destination kind is enabled; no external platform is integrated yet.

## Principles

1. Publishing is never hard-coded to a single (internal) target.
2. Content, Approval, Publishing Destination and Publishing Execution are separate.
3. Platforms are added through **Publisher Adapters**, without rewriting the AI
   agent or the human-approval workflow.
4. Every approval has an explicit destination scope. Approving one destination
   never authorises another (in particular, an internal approval is never
   extended to Telegram, Discord or Facebook).
5. A workspace may have many destinations, including several accounts, pages,
   groups, channels or servers of the same platform.
6. Platform credentials are never stored in posts, AI prompts, audit logs or
   responses.
7. Execution state is stored: status, external post id, error code, retries and
   an idempotency key, so a post is never published twice by mistake.
8. The AI agent may only **propose** publishing. Every external publication needs
   a human approval for that destination, enforced by the backend and database.
9. Build the minimum: interfaces and module boundaries first, real integrations
   only when needed.
10. Stay compatible with the M4 migrations, existing posts and the internal flow.

## The four concerns

```
Content ──► Approval (one version × one destination) ──► Execution (delivery) ──► Destination
                                                              ▲
                                                Publisher Adapter (per kind)
```

### Content
`content_posts` and the append-only snapshots in `content_post_versions`
(M2). Content is versioned; what gets published is always the snapshot of the
approved version, never "whatever the post contains now".

### Approval
`content_publish_requests` (M4.1, extended in M4.6a).

- One request = **one post version for one destination** (`destination_id`).
- At most one pending request per (post, destination); at most one approval per
  (post, destination, version).
- Decided once by an owner/admin of the request's workspace, in a separate,
  explicit action. The AI agent cannot approve (no tool; the RPC also refuses
  calls carrying the agent marker header).
- Any change to the post cancels its pending requests (all destinations): an
  approver never approves content other than what was requested.
- The approver confirms the destination too: `approve_publish_request(…,
  p_expected_destination_id)` fails with CP409 if it differs.
- Audit: `content_publish_request_events` (append-only) records requested /
  approved / rejected / cancelled / published.

### Publishing Destination
`publishing_destinations` (M4.6a).

| Column | Meaning |
|---|---|
| `workspace_id` | Owner workspace. Destinations are workspace-scoped (RLS). |
| `kind` | `internal` today; one value per platform later (`telegram`, `discord`, `facebook`…). A CHECK lists the enabled kinds; each new kind is enabled by its own migration. |
| `name` | Human label ("Nội bộ", "Kênh Telegram Marketing"). |
| `target_ref` | Public identifier of the target (chat id, channel id, page id). Never a secret. Always null for `internal`. |
| `status` | `active` / `disabled`. A disabled destination accepts no request and no approval (CP426). |

- Every workspace has exactly one permanent `internal` destination (created by a
  trigger; backfilled for existing workspaces). It cannot be disabled, retargeted
  or deleted.
- Members read destinations; owners/admins add, rename and disable them. No
  DELETE: destinations referenced by requests stay for the audit trail.

### Publishing Execution
`publish_deliveries` (M4.6a): one row per approved request.

| Column | Meaning |
|---|---|
| `request_id`, `destination_id`, `post_id`, `post_version` | Copied from the approved request (checked by a trigger). |
| `status` | `queued` → `sending` → `succeeded` / `failed` (retryable) / `cancelled`. `succeeded` and `cancelled` are final. |
| `attempt_count`, `next_attempt_at` | Retry bookkeeping. |
| `external_post_id` | Id returned by the platform (only on success). |
| `last_error_code` | Our own short code (e.g. `rate_limited`), never the platform's message or payload. |
| `idempotency_key` | `request:<request id>`, unique: one approval can only ever produce one delivery. |

- Clients may only read deliveries of their workspace. Rows are written by
  `approve_publish_request` and, in M5, by a server-side worker function.
- **Internal destination:** approval publishes the post (`content_posts.status =
  'published'`) and records a `succeeded` delivery in the same transaction
  (unchanged M4 behaviour). Only an internal approval may change the post status
  (enforced by the `content_posts_guard_publish` trigger).
- **External destination (M5):** approval only inserts a `queued` delivery. No
  network call happens inside the approval transaction.

## Publisher Adapter (application layer, M4.6b)

Server-only module `src/lib/publishing/`:

```ts
interface PublisherAdapter {
  kind: DestinationKind;
  /** Validates a destination's public target reference (no network). */
  validateTarget(targetRef: string | null): { ok: true } | { ok: false; code: string };
  /** Pure: turns the approved snapshot into the platform payload. */
  render(snapshot: ApprovedSnapshot): Payload;
  /** Performs the publication. Credentials are passed in, never stored by the adapter. */
  publish(
    payload: Payload,
    ctx: { credentials: Secret; idempotencyKey: string; targetRef: string | null },
  ): Promise<{ ok: true; externalId: string } | { ok: false; code: SafeErrorCode; retryable: boolean }>;
}
```

- A registry maps `kind` → adapter. M4.6b ships only `InternalPublisher`
  (publishing already happens in the approval transaction).
- The AI agent, approval UI and Server Actions only know `destination_id`,
  `name` and `kind`. Platform details live in the adapter.

## Credential security

- Platform tokens are never stored in `publishing_destinations`,
  `publish_deliveries`, posts, prompts, `agent_actions`, audit events, logs or
  API responses.
- M5 stores credentials separately, readable only server-side: Supabase Vault
  (preferred) or a dedicated table with server-side encryption whose key lives in
  the deployment environment. No client role gets SELECT on it; access goes
  through a narrowly scoped `SECURITY DEFINER` function or the server.
- The service-role key is not used by application code; if a worker ever needs
  elevated access it gets a dedicated, minimal database function instead.
- Logs record only safe codes (`src/lib/logging/safe-log.ts`).

## Idempotency, retries and external post ids

- One approval → one delivery (`unique (request_id)`, `unique (idempotency_key)`).
- The worker (M5) claims due deliveries (`status in ('queued','failed') and
  next_attempt_at <= now()`), sets `sending`, calls the adapter with the
  idempotency key, then records `succeeded` + `external_post_id`, or `failed` +
  `last_error_code` + backoff (`next_attempt_at`), up to a maximum number of
  attempts, after which a human decides.
- Adapters pass the idempotency key to platforms that support it. For platforms
  that do not, the worker checks `external_post_id` / `sending` state before
  retrying, so a timeout after a successful post does not publish twice.

## Compatibility notes (M4.6a)

- `request_post_publish` gained a last parameter `p_destination_id DEFAULT NULL`.
  Legacy callers (M4.2 data layer, M4.4 actions) keep working and get the
  workspace's internal destination. **Agent requests must name a destination**
  (22023 otherwise).
- `approve_publish_request` gained a last parameter
  `p_expected_destination_id DEFAULT NULL` (checked when given).
- The old signatures were dropped (no ambiguous overloads in PostgREST).
- Existing requests were backfilled to the internal destination; approvals made
  before M4.6a have no delivery row (none is invented).
- New error code: **CP426** destination disabled.

### Done in M4.6b (application layer)
- `src/lib/publishing/`: `PublisherAdapter` interface (`adapter.ts`), registry
  (`registry.ts`, no fallback for unknown kinds), `InternalPublisher`
  (`adapters/internal.ts`, `execution: "in_approval"`, never touches the
  network), `PublisherSecret` (`types.ts`: an opaque credential holder that
  never serialises its value) and read-only data access for destinations and
  deliveries (`destinations.ts`).
- The M4.2 data layer always sends `p_destination_id` and
  `p_expected_destination_id` explicitly. A destination must be visible, in the
  post's workspace and active (`not_found` / `destination_disabled`); legacy
  callers without one are mapped explicitly to the internal destination; the
  agent must always name one.
- Errors: CP426 → `destination_disabled`; a destination other than the reviewed
  one → `destination_mismatch` (Vietnamese messages, no database details).
- Server Actions require `destinationId` (request form) and
  `expectedDestinationId` (approve form).
- UI: "Đích xuất bản: Nội bộ" on the request form, the approval list and the
  review page; the confirmation step names the destination; the review page shows
  the execution state. No destination picker until a real external adapter exists.

### Done in M4.6c (AI agent publish requests)
- Agent tools `list_publish_destinations` (id, name, kind, status only) and
  `request_publish(post_id, expected_version, destination_id, reason)`:
  `destination_id` is mandatory, `get_post` with the same version is required
  first, it counts toward the write budget, and it only creates a **pending**
  request (source `agent`, `agent_turn_id` = the server-generated turn id).
- Actor isolation: `runAsAgent()` in `src/lib/supabase/server.ts`
  (AsyncLocalStorage) is called only by the `/api/agent` route around the agent
  turn. Clients created inside it send `x-contentpilot-actor: agent`; the
  database then refuses approve/reject and accepts only agent-marked requests.
  The actor is never read from the incoming request or from model output.
- Audit: migration `20261121150000_agent_publish_requests.sql` adds
  `agent_actions.kind = 'publish_request'` and `request_id`; a success row must
  match a real agent request of the same user, turn, post and version.
- No approve, reject, cancel or publish-execution tool exists for the agent.

## Extending to Telegram, Discord and Facebook (M5)

For each platform:

1. Migration: add the kind to the `publishing_destinations_kind_check` CHECK and
   its `target_ref` validation; add the credentials storage (once, for all kinds).
2. Adapter: `src/lib/publishing/adapters/<kind>.ts` implementing
   `PublisherAdapter` (render + publish, safe error codes, idempotency).
3. Worker: a server-side job (cron or queue) that processes `queued`/`failed`
   deliveries through the registry.
4. UI: owners/admins add the destination (name, target, credentials through a
   server-only form); requests and approvals pick the destination explicitly.
5. Agent: `list_publish_destinations` returns ids, names and kinds only; the
   agent proposes `request_publish(post, version, destination)`.
6. Decide the editing rule for posts already published to a social platform
   (deferred to M5).
7. Tests: DB tests for the new kind, adapter unit tests with recorded payloads,
   worker integration tests against a local fake platform — never a real account
   in CI.
