import "server-only";

import he from "he";

import type { SportsNewsItem } from "./feeds";

const imageHosts: Record<string, string[]> = {
  "thanhnien.vn": ["images2.thanhnien.vn"],
  "tuoitre.vn": ["cdn.tuoitre.vn"],
  "bongda24h.vn": ["bongda24h.vn", "static.bongda24h.vn"],
  "bongda.com.vn": ["bongda.com.vn", "media.bongda.com.vn"],
  "thethao247.vn": ["thethao247.vn", "cdn.thethao247.vn"],
};

function sourceHost(hostname: string) {
  return Object.keys(imageHosts).find((host) => hostname === host || hostname.endsWith(`.${host}`));
}

export async function findSourceSportsPhoto(item: SportsNewsItem) {
  try {
    const articleUrl = new URL(item.url);
    const host = sourceHost(articleUrl.hostname);
    if (!host || articleUrl.protocol !== "https:") return null;

    const page = await fetch(articleUrl, { redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!page.ok || !/text\/html/i.test(page.headers.get("content-type") ?? "")) return null;
    const html = (await page.text()).slice(0, 1_000_000);
    const tag = html.match(/<meta\b[^>]*\bproperty=["']og:image["'][^>]*>/i)?.[0];
    const raw = tag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
    if (!raw) return null;
    const photoUrl = new URL(he.decode(raw), articleUrl);
    if (photoUrl.protocol !== "https:" || photoUrl.port || photoUrl.username || photoUrl.password ||
        !imageHosts[host].includes(photoUrl.hostname)) return null;

    const response = await fetch(photoUrl, { redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok || !/^image\/(?:jpeg|png|webp)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 5_000_000 || bytes.length < 1000) return null;
    return { image: bytes.toString("base64"), metadata: { source: photoUrl.href, title: item.title, exactMatch: true } };
  } catch {
    return null;
  }
}
