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
  if (license === "CC0" && /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/.test(url)) {
    return { license, licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", author: null };
  }
  if (license === "Public domain" && fields.Copyrighted?.value.toLowerCase() === "false") {
    return { license, licenseUrl: null, author: null };
  }
  const match = /^CC BY(-SA)? (3\.0|4\.0)$/.exec(license);
  if (!match) return null;
  const path = `/licenses/by${match[1] ? "-sa" : ""}/${match[2]}/`;
  if (url.replace(/^http:/, "https:").replace(/\/?$/, "/") !== `https://creativecommons.org${path}`) return null;
  const author = plain(fields.Artist?.value ?? "");
  if (!author || author.length > 100) return null;
  return { license, licenseUrl: `https://creativecommons.org${path}`, author };
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

export async function findLicensedSportsPhoto(subject: string) {
  const terms = words(subject).filter((word) => word.length > 2);
  if (terms.length === 0) return null;
  try {
    const query = subject.replace(/[^\p{L}\p{N} .'-]/gu, "").trim();
    if (!query) return null;
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    url.search = new URLSearchParams({
      action: "query", generator: "search", gsrnamespace: "6", gsrlimit: "8",
      gsrsearch: `"${query}" filetype:bitmap`, prop: "imageinfo",
      iiprop: "url|mime|extmetadata", iiurlwidth: "960",
      iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|Copyrighted",
      format: "json",
    }).toString();
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000), headers: { "User-Agent": userAgent } });
    if (!response.ok) return null;
    const parsed = commonsResponse.safeParse(await response.json());
    if (!parsed.success) return null;
    const pages = Object.values(parsed.data.query?.pages ?? {}).sort((a, b) => (a.index ?? 100) - (b.index ?? 100));
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info || info.mime !== "image/jpeg") continue;
      const filename = words(page.title);
      if (!terms.every((term) => filename.includes(term))) continue;
      if (filename.some((word) => ["logo", "crest", "icon", "flag", "illustration", "drawing", "render"].includes(word))) continue;
      const license = photoLicense(info.extmetadata);
      if (!license) continue;
      const image = await downloadJpeg(info.thumburl ?? info.url);
      if (!image) return null;
      const source = `https://commons.wikimedia.org/?curid=${page.pageid}`;
      const attribution = license.author
        ? `📷 Ảnh tư liệu: ${license.author} · ${license.license}\n${source}\n${license.licenseUrl}`
        : "📷 Ảnh tư liệu";
      return { image, attribution, metadata: { source, title: page.title, ...license } };
    }
  } catch {
    // The original article can still be drafted when Commons is unavailable.
  }
  return null;
}
