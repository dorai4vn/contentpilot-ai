import type { PublisherAdapter, PublishOutcome } from "../adapter";
import type { ApprovedSnapshot } from "../types";

export type InternalPayload = { postId: string; postVersion: number; title: string; body: string };

/**
 * Internal destination. Publishing it is done by the database inside the approval
 * transaction (approve_publish_request sets the post to published and records a
 * succeeded delivery), so this adapter never publishes anything itself and never
 * touches the network. It exists so every destination kind goes through the same
 * registry and interface.
 */
export const internalPublisher: PublisherAdapter<InternalPayload> = {
  kind: "internal",
  execution: "in_approval",

  validateTarget(targetRef) {
    // The internal destination has no external target (database CHECK as well).
    return targetRef === null ? { ok: true } : { ok: false, code: "invalid_target" };
  },

  render(snapshot: ApprovedSnapshot): InternalPayload {
    return { postId: snapshot.postId, postVersion: snapshot.postVersion, title: snapshot.title, body: snapshot.body };
  },

  async publish(): Promise<PublishOutcome> {
    // Never called for "in_approval" adapters: there is nothing left to execute.
    return { ok: false, code: "not_applicable", retryable: false };
  },
};
