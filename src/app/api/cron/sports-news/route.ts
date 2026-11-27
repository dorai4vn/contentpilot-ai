import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { dubaiDate } from "@/lib/sports-news/publication-day";
import { checkSportsNewsSetup, readSportsNewsConfig, runSportsDelivery, runSportsNews } from "@/lib/sports-news/worker";

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
    const mode = params.get("mode");
    const testDate = mode === "test" ? params.get("date") : undefined;
    if (mode === "test" && (!testDate || !z.iso.date().safeParse(testDate).success ||
        testDate >= dubaiDate(Date.now()) || testDate < dubaiDate(Date.now() - 48 * 60 * 60 * 1000))) {
      return Response.json({ error: "invalid_test_date" }, { status: 400 });
    }
    if (mode === "setup" && channel !== null && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(channel)) {
      return Response.json({ error: "invalid_channel" }, { status: 400 });
    }
    if (mode === "deliver") {
      // Delivery-only: sends already-approved items; never reads RSS or drafts anything.
      return Response.json(await runSportsDelivery(config), { headers: { "Cache-Control": "no-store" } });
    }
    const report = mode === "setup"
      ? await checkSportsNewsSetup(config, channel ?? undefined)
      : await runSportsNews(config, testDate ?? undefined);
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "sports_news_run_failed" }, { status: 503 });
  }
}
