import { createHash, timingSafeEqual } from "node:crypto";
import { readSportsNewsConfig, runSportsNews } from "@/lib/sports-news/worker";

export const maxDuration = 180;

function hash(value: string) {
  return createHash("sha256").update(value).digest();
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeEqual(hash(request.headers.get("authorization") ?? ""), hash(`Bearer ${secret}`))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await runSportsNews(readSportsNewsConfig());
    return Response.json(report);
  } catch {
    return Response.json({ error: "sports_news_run_failed" }, { status: 503 });
  }
}
