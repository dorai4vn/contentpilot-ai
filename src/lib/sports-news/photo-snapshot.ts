import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export async function readSportsPhoto(client: SupabaseClient<Database>, postId: string, version: number) {
  const result = version === 1
    ? await client.from("sports_news_items").select("image_base64").eq("post_id", postId).maybeSingle()
    : await client.from("sports_news_revision_photos").select("image_base64")
      .eq("post_id", postId).eq("post_version", version).maybeSingle();
  if (result.error) throw new Error("sports_news_image_read_failed");
  return result.data?.image_base64 ?? null;
}
