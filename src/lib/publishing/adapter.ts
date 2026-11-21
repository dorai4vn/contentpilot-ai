import type { ApprovedSnapshot, DestinationKind, PublisherErrorCode, PublisherSecret } from "./types";

/**
 * Publisher Adapter: everything platform-specific about publishing lives behind
 * this interface (docs/architecture/publishing.md). The AI agent, the approval
 * workflow and the UI only know destination ids, names and kinds.
 *
 * Rules for implementations:
 *   - Never store credentials; they are passed in for one call only.
 *   - Report failures with a safe PublisherErrorCode, never a platform message.
 *   - Use the idempotency key so one approval can never be published twice.
 */
export interface PublisherAdapter<Payload = unknown> {
  readonly kind: DestinationKind;
  /**
   * "in_approval": publishing happens inside the approval transaction (internal).
   * "async": approval queues a delivery; a server-side worker calls publish() (M5).
   */
  readonly execution: "in_approval" | "async";
  /** Checks a destination's public target reference (no network). */
  validateTarget(targetRef: string | null): { ok: true } | { ok: false; code: "invalid_target" };
  /** Pure: turns the approved snapshot into the platform payload. */
  render(snapshot: ApprovedSnapshot): Payload;
  /** Publishes the payload. Credentials are passed in, never kept. */
  publish(payload: Payload, context: PublishContext): Promise<PublishOutcome>;
}

export type PublishContext = {
  idempotencyKey: string;
  targetRef: string | null;
  /** Null for destinations that need none (internal). */
  credentials: PublisherSecret | null;
};

export type PublishOutcome =
  | { ok: true; externalId: string }
  | { ok: false; code: PublisherErrorCode; retryable: boolean };
