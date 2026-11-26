import type { PublisherAdapter } from "./adapter";
import { internalPublisher } from "./adapters/internal";
import { socialPublisher } from "./adapters/social";
import type { DestinationKind } from "./types";

/**
 * Registry of Publisher Adapters by destination kind. Adding a platform (M5) =
 * one adapter here + one migration enabling its kind. Kinds without an adapter
 * are not publishable, whatever the database contains.
 */
const ADAPTERS: Readonly<Record<DestinationKind, PublisherAdapter>> = Object.freeze({
  internal: internalPublisher as PublisherAdapter,
  telegram: socialPublisher("telegram") as PublisherAdapter,
  discord: socialPublisher("discord") as PublisherAdapter,
  facebook: socialPublisher("facebook") as PublisherAdapter,
});

export class UnsupportedDestinationKindError extends Error {
  constructor() {
    super("No publisher adapter for this destination kind");
    this.name = "UnsupportedDestinationKindError";
  }
}

/** True when an adapter exists for this kind (any string accepted: data may come from the database). */
export function isSupportedKind(kind: string): kind is DestinationKind {
  return Object.hasOwn(ADAPTERS, kind);
}

/** The adapter for a kind, or UnsupportedDestinationKindError (never a silent fallback). */
export function getPublisher(kind: string): PublisherAdapter {
  if (!isSupportedKind(kind)) throw new UnsupportedDestinationKindError();
  return ADAPTERS[kind];
}

/** Kinds that can be offered in the UI and to the agent. */
export function supportedKinds(): DestinationKind[] {
  return Object.keys(ADAPTERS) as DestinationKind[];
}
