import "server-only";

import he from "he";
import { z } from "zod";

const maxImageBytes = 1_500_000;
const userAgent = "ContentPilotAI/1.0 (https://github.com/dorai4vn/contentpilot-ai)";
const metadata = z.record(z.string(), z.object({ value: z.string() }));
const commonsResponse = z.object({
  query: z.object({
    pages: z.record(z.string(), z.object({
      pageid: z.number().int().positive(),
      title: z.string(),
      index: z.number().optional(),
      imageinfo: z.array(z.object({
        thumburl: z.string().optional(),
        url: z.string(),
        mime: z.string(),
        extmetadata: metadata,
      })).optional(),
    })),
  }).optional(),
});

function plain(value: string) {
  return he.decode(value.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function words(value: string): string[] {
  return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/\bmunchen\b/g, "munich").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function photoLicense(fields: z.infer<typeof metadata>) {
  const license = plain(fields.LicenseShortName?.value ?? "");
  const url = fields.LicenseUrl?.value ?? "";
  const author = plain(fields.Artist?.value ?? "").slice(0, 100) || null;
  if (license === "CC0" && /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0(?:\/(?:deed(?:\.[a-z-]+)?|legalcode)?)?$/.test(url)) {
    return { license, licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", author };
  }
  if (license === "Public domain" && fields.Copyrighted?.value.toLowerCase() === "false") {
    return { license, licenseUrl: null, author };
  }
  return null;
}

async function downloadJpeg(raw: string) {
  const url = new URL(raw);
  if (!["https://upload.wikimedia.org", "https://thumb.wikimedia.org"].includes(url.origin) || url.username || url.password ||
      !url.pathname.startsWith("/wikipedia/commons/")) return null;
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000), headers: { "User-Agent": userAgent } });
  if (!response.ok || !response.body || !/^image\/jpeg(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxImageBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const image = Buffer.concat(chunks);
  return image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff ? image.toString("base64") : null;
}

function photoDate(title: string, original?: string) {
  const parsed = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(original ?? "");
  return parsed ? parsed.slice(1).join("-") : /\b\d{4}-\d{2}-\d{2}\b/.exec(title)?.[0];
}

type MatchPhoto = { opponent: string; playedOn: string };
type SearchMode = "subject" | "past-meeting" | "team-action";

export async function findLicensedSportsPhoto(subject: string, match?: MatchPhoto, mode: SearchMode = "subject") {
  const terms = words(subject).filter((word) => word.length > 2);
  const opponentTerms = match ? words(match.opponent).filter((word) => word.length > 2) : [];
  if (match && opponentTerms.length === 0) return null;
  if (terms.length === 0) return null;
  try {
    const query = subject.replace(/[^\p{L}\p{N} .'-]/gu, "").trim();
    const opponent = match?.opponent.replace(/[^\p{L}\p{N} .'-]/gu, "").trim();
    if (!query || (match && !opponent)) return null;
    const queries = match ? [`intitle:"${query}" intitle:"${opponent}" filetype:bitmap`]
      : mode === "team-action"
        ? ["Fußball", "match", "tegen"].map((term) => `intitle:"${query}" intitle:${term} filetype:bitmap -basketball`)
        : [`"${query}" filetype:bitmap`];
    const results = await Promise.allSettled(queries.map(async (search) => {
      const url = new URL("https://commons.wikimedia.org/w/api.php");
      url.search = new URLSearchParams({
        action: "query", generator: "search", gsrnamespace: "6", gsrlimit: "12",
        gsrsearch: search, prop: "imageinfo",
        iiprop: "url|mime|extmetadata", iiurlwidth: "960",
        iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|Copyrighted|DateTimeOriginal",
        format: "json",
      }).toString();
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000), headers: { "User-Agent": userAgent } });
      if (!response.ok) return [];
      const parsed = commonsResponse.safeParse(await response.json());
      return parsed.success ? Object.values(parsed.data.query?.pages ?? {})
        .sort((a, b) => (a.index ?? 100) - (b.index ?? 100)) : [];
    }));
    const pages = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (match) {
      const isExactDate = (page: (typeof pages)[number]) =>
        photoDate(page.title, page.imageinfo?.[0]?.extmetadata.DateTimeOriginal?.value) === match.playedOn;
      pages.sort((a, b) => Number(isExactDate(b)) - Number(isExactDate(a)));
    }
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info || info.mime !== "image/jpeg") continue;
      const filename = words(page.title);
      if (![...terms, ...opponentTerms].every((term) => filename.includes(term))) continue;
      const takenOn = photoDate(page.title, info.extmetadata.DateTimeOriginal?.value);
      const exact = !!match && takenOn === match.playedOn;
      const action = filename.some((word) => ["vs", "gegen", "tegen", "match", "spiel", "supercup", "bundesliga"].includes(word));
      if (match && !exact && (mode !== "past-meeting" || !takenOn || takenOn >= match.playedOn || !action)) continue;
      if (mode === "team-action" && (!action || filename.some((word) =>
        ["basketball", "feminin", "frauen", "women", "futsal", "alzenau", "training", "women's"].includes(word)))) continue;
      if (!match && (!action || mode !== "team-action") &&
          filename.some((word) => ["stadium", "arena", "stadion", "estadio"].includes(word))) continue;
      if (filename.some((word) => ["logo", "crest", "icon", "flag", "illustration", "drawing", "render"].includes(word))) continue;
      const license = photoLicense(info.extmetadata);
      if (!license) continue;
      const image = await downloadJpeg(info.thumburl ?? info.url);
      if (!image) return null;
      const source = `https://commons.wikimedia.org/?curid=${page.pageid}`;
      return { image, metadata: { source, title: page.title, ...license, exactMatch: exact } };
    }
  } catch {
    // The original article can still be drafted when Commons is unavailable.
  }
  return null;
}

export async function findSportsPostPhoto(subject: string, match?: MatchPhoto, requireAction = false) {
  if (!match) return findLicensedSportsPhoto(subject, undefined, requireAction ? "team-action" : "subject");
  return await findLicensedSportsPhoto(subject, match, "past-meeting")
    ?? await findLicensedSportsPhoto(subject, undefined, "team-action")
    ?? await findLicensedSportsPhoto(match.opponent, undefined, "team-action");
}
