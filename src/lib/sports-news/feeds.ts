import { XMLParser, XMLValidator } from "fast-xml-parser";
import he from "he";

import { sportsFeeds, type SportsFeedSource } from "./sources";

export type SportsNewsItem = {
  source: string;
  url: string;
  title: string;
  summary: string;
  publishedAt: number;
  categories?: string;
};

const parser = new XMLParser({ parseTagValue: false, processEntities: false });
const maxBytes = 512 * 1024;
const day = 24 * 60 * 60 * 1000;

function plainText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return he.decode(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function dateInVietnam(value: unknown, localDateFormat?: SportsFeedSource["localDateFormat"]): number {
  if (typeof value !== "string") return NaN;
  const date = value.replace(/\s/g, " ").trim();
  if (localDateFormat === "year-first") {
    const localTime = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(date);
    if (localTime) {
      const [, year, month, dayOfMonth, time] = localTime;
      return Date.parse(`${year}-${month}-${dayOfMonth}T${time}+07:00`);
    }
  }
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ?(AM|PM)$/i.exec(date);
  if (local) {
    const [, month, dayOfMonth, year, hour, minute, second, period] = local;
    const hour24 = Number(hour) % 12 + (period.toUpperCase() === "PM" ? 12 : 0);
    return Date.parse(`${year}-${month.padStart(2, "0")}-${dayOfMonth.padStart(2, "0")}T${String(hour24).padStart(2, "0")}:${minute}:${second}+07:00`);
  }
  return /(?:[+-]\d{2}:?\d{2}|GMT|UTC|Z)$/i.test(date) ? Date.parse(date) : NaN;
}

function sourceUrl(value: unknown, host: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(he.decode(value.trim()));
    if (url.origin !== `https://${host}` || url.username || url.password || url.pathname === "/") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href.length <= 240 ? url.href : null;
  } catch {
    return null;
  }
}

export function parseSportsFeed(xml: string, source: SportsFeedSource, now: number): SportsNewsItem[] {
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error("invalid_sports_feed");
  }
  const channel = parser.parse(xml)?.rss?.channel;
  if (!channel || typeof channel !== "object") throw new Error("invalid_sports_feed");
  const items: unknown[] = [channel.item ?? []].flat();
  const host = new URL(source.url).hostname;
  return items.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const fields = item as Record<string, unknown>;
    const url = sourceUrl(fields.link, host);
    const title = plainText(fields.title, 300);
    const summary = plainText(fields.description, 2000);
    const publishedAt = dateInVietnam(fields.pubDate, source.localDateFormat);
    const categories = [fields.category ?? []].flat().map((value) => plainText(value, 150))
      .filter(Boolean).join(", ").slice(0, 300);
    if (!url || !title || !summary || !Number.isFinite(publishedAt) ||
      publishedAt < now - 2 * day || publishedAt > now + 5 * 60 * 1000) return [];
    return [{ source: source.name, url, title, summary, publishedAt, ...(categories ? { categories } : {}) }];
  });
}

async function loadFeed(source: SportsFeedSource, now: number): Promise<SportsNewsItem[]> {
  const response = await fetch(source.url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: { accept: "application/rss+xml, application/xml, text/xml" },
  });
  if (!response.ok || !response.body) throw new Error("sports_feed_unavailable");
  let bytes = 0;
  let xml = "";
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("sports_feed_too_large");
      }
      xml += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return parseSportsFeed(xml + decoder.decode(), source, now);
}

export async function collectSportsNews(now = Date.now()) {
  const results = await Promise.allSettled(sportsFeeds.map((source) => loadFeed(source, now)));
  const available = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  available.sort((first, second) => second.publishedAt - first.publishedAt);
  const seen = new Set<string>();
  const articles = available.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
  const unavailableSources = sportsFeeds.filter((_, index) => results[index].status === "rejected").map(({ name, section }) => section ? `${name} · ${section}` : name);
  return { articles, unavailableSources };
}
