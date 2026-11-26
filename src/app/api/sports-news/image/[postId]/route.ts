import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: RouteContext<"/api/sports-news/image/[postId]">) {
  const postId = z.uuid().safeParse((await params).postId);
  if (!postId.success) return new Response(null, { status: 404 });

  const supabase = await createClient();
  const { data, error } = await supabase.from("sports_news_items")
    .select("image_base64").eq("post_id", postId.data).maybeSingle();
  if (error || !data?.image_base64) return new Response(null, { status: 404 });
  return new Response(Uint8Array.from(Buffer.from(data.image_base64, "base64")), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
