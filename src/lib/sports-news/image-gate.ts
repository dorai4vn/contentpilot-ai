import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { readSportsPhoto } from "./photo-snapshot";

/** FN11-B: structured skip reasons for the No Image No Publish gate (RSS sports posts only). */
export const NO_IMAGE_SKIP_CODES = ["no_image", "image_invalid"] as const;
export type NoImageSkipCode = (typeof NO_IMAGE_SKIP_CODES)[number];

export type RssImageGate =
  | { ok: true; image: Uint8Array<ArrayBuffer> }
  | { ok: false; code: NoImageSkipCode };

/**
 * Final pre-send image gate. Fails closed: a missing image, an unreadable row or a crop failure all yield a skip
 * code and NEVER a text-only fallback. Callers must not call a publisher when `ok` is false.
 */
export async function requireRssImage(client: SupabaseClient<Database>, postId: string, version: number): Promise<RssImageGate> {
  let image: Uint8Array<ArrayBuffer> | null;
  try {
    image = await readSportsPhoto(client, postId, version);
  } catch {
    return { ok: false, code: "image_invalid" };
  }
  return image && image.byteLength > 0 ? { ok: true, image } : { ok: false, code: "no_image" };
}
