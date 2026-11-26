import { z } from "zod";
import { readSportsPhoto } from "@/lib/sports-news/photo-snapshot";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request, { params }: RouteContext<"/api/sports-news/image/[postId]">) {
  const postId = z.uuid().safeParse((await params).postId);
  if (!postId.success) return new Response(null, { status: 404 });

  const version = z.coerce.number().int().positive().safeParse(new URL(request.url).searchParams.get("version") ?? "1");
  if (!version.success) return new Response(null, { status: 404 });
  const supabase = await createClient();
  const image = await readSportsPhoto(supabase, postId.data, version.data).catch(() => null);
  if (!image) return new Response(null, { status: 404 });
  return new Response(image, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
