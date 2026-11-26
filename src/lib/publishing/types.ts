import type {
  PublishDeliveryStatus,
  PublishingDestinationKind,
  PublishingDestinationStatus,
} from "@/types/database";

/**
 * Shared types of the publishing module (docs/architecture/publishing.md).
 * Four separate concerns: Content (versioned posts), Approval (one version for one
 * destination), Destination (where to publish) and Execution (deliveries).
 * Nothing here holds a credential.
 */

/** Destination kinds enabled in the database (CHECK). */
export type DestinationKind = PublishingDestinationKind;

/** A publishing destination as the app sees it: no credentials, only public data. */
export type PublishingDestination = {
  id: string;
  workspaceId: string;
  kind: DestinationKind;
  name: string;
  /** Public identifier of the external target (chat / channel / page). Null for internal. */
  targetRef: string | null;
  status: PublishingDestinationStatus;
  createdAt: string;
};

/** Execution record of one approved request on its destination. */
export type PublishDelivery = {
  id: string;
  workspaceId: string;
  requestId: string;
  destinationId: string;
  postId: string;
  postVersion: number;
  status: PublishDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  externalPostId: string | null;
  /** Our own safe error code only (never a platform message). */
  lastErrorCode: string | null;
  createdAt: string;
  completedAt: string | null;
};

/** The approved content to publish: the snapshot of the approved version, never the live post. */
export type ApprovedSnapshot = {
  postId: string;
  postVersion: number;
  title: string;
  body: string;
  image?: Uint8Array<ArrayBuffer>;
};

/** Short, safe error codes an adapter may report (stored in publish_deliveries.last_error_code). */
export type PublisherErrorCode =
  | "invalid_target"
  | "not_applicable"
  | "unauthorized"
  | "rate_limited"
  | "content_rejected"
  | "delivery_unconfirmed"
  | "network_error"
  | "platform_error";

/**
 * Opaque holder for a platform credential (M5). It never serialises its value:
 * JSON, string conversion and console inspection all print "[redacted]", so it
 * cannot leak into logs, prompts, audit rows or API responses by accident.
 */
export class PublisherSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The raw value, only for the adapter call that needs it. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[redacted]";
  }

  toString(): string {
    return "[redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "PublisherSecret([redacted])";
  }
}
