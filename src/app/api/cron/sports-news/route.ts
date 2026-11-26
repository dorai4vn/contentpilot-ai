import { createHash, timingSafeEqual } from "node:crypto";
import { checkSportsNewsSetup, readSportsNewsConfig, runSportsNews } from "@/lib/sports-news/worker";

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
    const config = readSportsNewsConfig();
    const report = new URL(request.url).searchParams.get("mode") === "setup"
      ? await checkSportsNewsSetup(config)
      : await runSportsNews(config);
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "sports_news_run_failed" }, { status: 503 });
  }
}
