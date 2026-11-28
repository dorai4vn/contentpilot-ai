import "server-only";

import type { SportsNewsItem } from "./feeds";
import { acquireSourceImage } from "./image-acquisition";
import { validateImageRelevance, type ValidateDeps } from "./image-relevance";
import { findSportsPostPhoto } from "./licensed-photo";

/** Source-article image (FN11-A1) that already passed the local relevance validation (FN11-A2). */
export async function findSourceSportsPhoto(item: SportsNewsItem) {
  return acquireSourceImage(item);
}

type FallbackPhoto = NonNullable<Awaited<ReturnType<typeof findSportsPostPhoto>>>;

/**
 * FN11-A2: a Wikimedia (or any other non-article) photo can NEVER bypass validation. It must pass the same local
 * hybrid check, with the Commons file title as the corroborating hint. Fails closed: returns null when it does not.
 */
export async function validateFallbackPhoto(
  photo: FallbackPhoto | null, item: Pick<SportsNewsItem, "title" | "url">, deps?: ValidateDeps,
): Promise<(FallbackPhoto & { metadata: FallbackPhoto["metadata"] & { visualQc: "local_pass" } }) | null> {
  if (!photo) return null;
  const verdict = await validateImageRelevance(
    Buffer.from(photo.image, "base64"),
    { title: item.title, method: "wikimedia", hint: photo.metadata.title, sourceUrl: photo.metadata.source }, deps,
  );
  return verdict.ok ? { ...photo, metadata: { ...photo.metadata, visualQc: "local_pass" as const } } : null;
}
