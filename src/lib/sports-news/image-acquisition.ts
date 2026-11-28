import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import he from "he";
import sharp from "sharp";

import type { SportsNewsItem } from "./feeds";
import { createImageBudget, type ImageBudget } from "./image-budget";
import { validateImageRelevance, type RelevanceVerdict } from "./image-relevance";

/**
 * FN11-A1 image ACQUISITION + A2 validation hook. Candidates are found and safely downloaded here, then EACH one is
 * passed through the local relevance validator (image-relevance.ts) before it can be returned. The first validated
 * candidate wins (max 5 tried). If the validator is unavailable/uncertain the candidate is dropped: fail closed.
 * `visualQc: "local_pass"` means the local hybrid check passed (model class scores + provenance), NOT a human or
 * frontier-model verification and NOT identification of players/event from pixels.
 */

export type ImageMethod = "rss_media" | "og_image" | "twitter_image" | "json_ld" | "lead_image" | "search_provider";

export type ImageCandidate = { url: string; method: ImageMethod; hint?: string };

export type AcquiredImage = {
  image: string; // base64
  metadata: {
    source: string; // image URL
    articleUrl: string;
    method: ImageMethod;
    title: string;
    width: number;
    height: number;
    bytes: number;
    format: "jpeg" | "png" | "webp";
    exactMatch: false;
    verification: "local_hybrid";
    visualQc: "local_pass";
    qc: { football: number; negative: number; model: string; cached: boolean };
  };
};

/** Pluggable search adapter (e.g. a configured image search API). No provider is bundled; none is called by default. */
export type ImageSearchProvider = {
  name: string;
  search(query: string, signal: AbortSignal): Promise<ImageCandidate[]>;
};

export type AcquisitionDeps = {
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  allowedHosts?: readonly string[];
  searchProvider?: ImageSearchProvider | null;
  /** Shared per-article candidate budget (also consumed by the Wikimedia fallback). */
  budget?: ImageBudget;
  /** Relevance validator. Defaults to the real local model; tests inject a MOCK. */
  validate?: (bytes: Uint8Array, ctx: { title: string; method: string; hint?: string; sourceUrl: string }) => Promise<RelevanceVerdict>;
};

const MAX_BYTES = 5_000_000;
const MIN_BYTES = 1000;
const MIN_SIDE = 400;
const MAX_SIDE = 8000;
const MAX_REDIRECTS = 3;
const MAX_HTML = 1_000_000;
const MAX_CANDIDATES = 5;
const TIMEOUT_MS = 8000;

/** Built-in public football news sites (article page host -> accepted image/CDN hosts). */
const DEFAULT_SOURCES: Record<string, string[]> = {
  "thanhnien.vn": ["images2.thanhnien.vn"],
  "tuoitre.vn": ["cdn.tuoitre.vn"],
  "bongda24h.vn": ["bongda24h.vn", "static.bongda24h.vn"],
  "bongda.com.vn": ["bongda.com.vn", "media.bongda.com.vn"],
  "thethao247.vn": ["thethao247.vn", "cdn.thethao247.vn"],
};

/**
 * Extra allowed public hosts (official club/league sites, public fanpage CDNs reachable without login) come from
 * SPORTS_IMAGE_ALLOWED_HOSTS, comma separated, e.g. "arsenal.com,premierleague.com". Each entry allows that host and
 * its subdomains for BOTH article pages and images. Never put private/login-only hosts here.
 */
export function configuredImageHosts(env: string | undefined = process.env.SPORTS_IMAGE_ALLOWED_HOSTS): string[] {
  return (env ?? "").split(",").map((host) => host.trim().toLowerCase())
    .filter((host) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host));
}

function hostMatches(hostname: string, host: string) {
  return hostname === host || hostname.endsWith(`.${host}`);
}

function allowedImageHost(articleHost: string, imageHost: string, extra: readonly string[]) {
  const builtin = Object.keys(DEFAULT_SOURCES).find((host) => hostMatches(articleHost, host));
  if (builtin && DEFAULT_SOURCES[builtin].includes(imageHost)) return true;
  return extra.some((host) => hostMatches(imageHost, host));
}

function allowedArticleHost(hostname: string, extra: readonly string[]) {
  return Object.keys(DEFAULT_SOURCES).some((host) => hostMatches(hostname, host)) ||
    extra.some((host) => hostMatches(hostname, host));
}

export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (isIP(lower) === 6) {
    if (lower === "::1" || lower === "::" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const parts = lower.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

async function defaultResolve(hostname: string) {
  return (await lookup(hostname, { all: true })).map((entry) => entry.address);
}

/** Validates scheme/port/credentials/IP-literal and that every resolved address is public. Throws on failure. */
async function assertSafeUrl(url: URL, resolveHost: (hostname: string) => Promise<string[]>) {
  if (url.protocol !== "https:" || url.port || url.username || url.password || isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      url.hostname === "localhost" || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) {
    throw new Error("unsafe_url");
  }
  const addresses = await resolveHost(url.hostname);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error("unsafe_address");
}

/** GET with manual, bounded redirects; every hop re-validated (SSRF) and re-checked against the host policy. */
async function safeGet(
  start: URL, deps: Required<Pick<AcquisitionDeps, "fetchImpl" | "resolveHost">>, hostOk: (host: string) => boolean,
  accept: string,
): Promise<Response> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!hostOk(url.hostname)) throw new Error("host_not_allowed");
    await assertSafeUrl(url, deps.resolveHost);
    const response = await deps.fetchImpl(url, {
      redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept, "user-agent": "ContentPilotAI/1.0" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error("bad_redirect");
      url = new URL(location, url);
      continue;
    }
    return response;
  }
  throw new Error("too_many_redirects");
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function signature(bytes: Uint8Array): "jpeg" | "png" | "webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  const ascii = (from: number, to: number) => Buffer.from(bytes.slice(from, to)).toString("latin1");
  return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" ? "webp" : null;
}

/** URL/alt-text heuristics that reject obvious non-photo or non-football candidates. Not a visual check. */
const REJECT_TERMS = [
  "logo", "icon", "avatar", "sprite", "placeholder", "default", "favicon", "banner", "ads", "advert", "badge", "crest",
  "flag", "emoji", "watermark", "thumbnail-small", "basketball", "nba", "tennis", "painting", "artwork", "canvas",
  "street", "skyline", "cityscape", "building", "museum", "mural", "cartoon", "illustration",
];

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function rejectCandidateReason(candidate: ImageCandidate): string | null {
  const text = `${safeDecode(candidate.url.split("?")[0]).toLowerCase()} ${(candidate.hint ?? "").toLowerCase()}`;
  const tokens: string[] = text.match(/[a-z0-9]+/g) ?? [];
  const hit = REJECT_TERMS.find((term) => tokens.includes(term) || (term.length > 4 && text.includes(term)));
  return hit ? `rejected_term:${hit}` : null;
}

function attr(tag: string, name: string) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : he.decode(value);
}

function metaContent(html: string, key: "og:image" | "og:image:secure_url" | "twitter:image") {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    if (name === key) return attr(tag, "content");
  }
  return undefined;
}

function jsonLdImages(html: string): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || !node) return;
    if (Array.isArray(node)) return node.forEach((child) => visit(child, depth + 1));
    if (typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const image = record.image ?? record.thumbnailUrl;
    for (const entry of [image].flat() as unknown[]) {
      if (typeof entry === "string") out.push(entry);
      else if (entry && typeof entry === "object" && typeof (entry as { url?: unknown }).url === "string") {
        out.push((entry as { url: string }).url);
      }
    }
    visit(record["@graph"], depth + 1);
    visit(record.mainEntity, depth + 1);
  };
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    try {
      visit(JSON.parse(script[1]), 0);
    } catch {
      // Malformed JSON-LD is simply ignored.
    }
  }
  return out;
}

function leadImage(html: string): { url: string; hint?: string } | null {
  const body = /<(?:article|main)\b[\s\S]*/i.exec(html)?.[0] ?? html;
  for (const tag of body.match(/<img\b[^>]*>/gi) ?? []) {
    const src = attr(tag, "src") ?? attr(tag, "data-src");
    if (src && !src.startsWith("data:")) return { url: src, hint: attr(tag, "alt") };
  }
  return null;
}

/** Candidate discovery from a fetched article page, in priority order. Pure; resolves relative URLs. */
export function discoverCandidates(html: string, articleUrl: URL, rssMedia?: string): ImageCandidate[] {
  const raw: ImageCandidate[] = [];
  if (rssMedia) raw.push({ url: rssMedia, method: "rss_media" });
  const og = metaContent(html, "og:image:secure_url") ?? metaContent(html, "og:image");
  if (og) raw.push({ url: og, method: "og_image" });
  const twitter = metaContent(html, "twitter:image");
  if (twitter) raw.push({ url: twitter, method: "twitter_image" });
  for (const url of jsonLdImages(html)) raw.push({ url, method: "json_ld" });
  const lead = leadImage(html);
  if (lead) raw.push({ url: lead.url, method: "lead_image", hint: lead.hint });
  const seen = new Set<string>();
  const out: ImageCandidate[] = [];
  for (const candidate of raw) {
    try {
      const resolved = new URL(candidate.url, articleUrl);
      resolved.hash = "";
      if (seen.has(resolved.href)) continue;
      seen.add(resolved.href);
      out.push({ ...candidate, url: resolved.href });
    } catch {
      // Skip unparsable URLs.
    }
  }
  return out;
}

async function downloadCandidate(
  candidate: ImageCandidate, articleUrl: URL, title: string,
  deps: Required<Pick<AcquisitionDeps, "fetchImpl" | "resolveHost">>, extra: readonly string[],
  validate: NonNullable<AcquisitionDeps["validate"]>,
): Promise<AcquiredImage | null> {
  if (rejectCandidateReason(candidate)) return null;
  const url = new URL(candidate.url);
  const hostOk = (host: string) => allowedImageHost(articleUrl.hostname, host, extra);
  const response = await safeGet(url, deps, hostOk, "image/jpeg,image/png,image/webp");
  if (!response.ok || !/^image\/(?:jpeg|png|webp)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return null;
  const bytes = await readBounded(response, MAX_BYTES);
  if (!bytes || bytes.length < MIN_BYTES) return null;
  const format = signature(bytes);
  if (!format) return null;
  const info = await sharp(bytes, { limitInputPixels: MAX_SIDE * MAX_SIDE }).metadata().catch(() => null);
  if (!info?.width || !info.height || info.format !== format) return null;
  if (info.width < MIN_SIDE || info.height < MIN_SIDE || info.width > MAX_SIDE || info.height > MAX_SIDE) return null;
  const verdict = await validate(bytes, { title, method: candidate.method, hint: candidate.hint, sourceUrl: url.href });
  if (!verdict.ok) return null;
  return {
    image: Buffer.from(bytes).toString("base64"),
    metadata: {
      source: url.href, articleUrl: articleUrl.href, method: candidate.method, title, width: info.width, height: info.height,
      bytes: bytes.length, format, exactMatch: false, verification: "local_hybrid", visualQc: "local_pass",
      qc: { football: verdict.football, negative: verdict.negative, model: verdict.modelVersion, cached: verdict.cached },
    },
  };
}

/**
 * Finds the first acceptable candidate image for an RSS article: RSS media -> OG -> Twitter -> JSON-LD -> lead image.
 * Fail-closed: any problem yields null. A non-null result has passed the local hybrid relevance validation.
 */
export async function acquireSourceImage(item: SportsNewsItem & { imageUrl?: string }, deps: AcquisitionDeps = {}) {
  const extra = deps.allowedHosts ?? configuredImageHosts();
  const resolved = { fetchImpl: deps.fetchImpl ?? fetch, resolveHost: deps.resolveHost ?? defaultResolve };
  const validate = deps.validate ?? validateImageRelevance;
  const budget = deps.budget ?? createImageBudget();
  try {
    const articleUrl = new URL(item.url);
    if (articleUrl.protocol !== "https:" || !allowedArticleHost(articleUrl.hostname, extra)) return null;
    const page = await safeGet(articleUrl, resolved, (host) => allowedArticleHost(host, extra), "text/html");
    let candidates: ImageCandidate[] = [];
    if (page.ok && /text\/html/i.test(page.headers.get("content-type") ?? "")) {
      const body = await readBounded(page, MAX_HTML);
      if (body) candidates = discoverCandidates(new TextDecoder().decode(body), articleUrl, item.imageUrl);
    } else if (item.imageUrl) {
      candidates = discoverCandidates("", articleUrl, item.imageUrl);
    }
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      if (!budget.take()) return null;
      try {
        const acquired = await downloadCandidate(candidate, articleUrl, item.title, resolved, extra, validate);
        if (acquired) return acquired;
      } catch {
        // Bounded substitution: try the next candidate.
      }
    }
    const provider = deps.searchProvider;
    if (provider) {
      const found = await provider.search(item.title, AbortSignal.timeout(TIMEOUT_MS));
      for (const candidate of found.slice(0, MAX_CANDIDATES)) {
        if (!budget.take()) return null;
        try {
          const acquired = await downloadCandidate({ ...candidate, method: "search_provider" }, articleUrl, item.title, resolved, extra, validate);
          if (acquired) return acquired;
        } catch {
          // next
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}
