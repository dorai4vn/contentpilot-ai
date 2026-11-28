import "server-only";

import type { SportsNewsItem } from "./feeds";
import { acquireSourceImage } from "./image-acquisition";

/** Source-article image (FN11-A1). Returns an UNVERIFIED candidate (visualQc: "pending_a2"); see image-acquisition.ts. */
export async function findSourceSportsPhoto(item: SportsNewsItem) {
  return acquireSourceImage(item);
}
