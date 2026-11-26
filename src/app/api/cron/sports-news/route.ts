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
    const params = new URL(request.url).searchParams;
    const channel = params.get("channel");
    if (params.get("mode") === "setup" && channel !== null && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(channel)) {
      return Response.json({ error: "invalid_channel" }, { status: 400 });
    }
    const report = params.get("mode") === "setup"
      ? await checkSportsNewsSetup(config, channel ?? undefined)
      : await runSportsNews(config);
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "sports_news_run_failed" }, { status: 503 });
  }
}
