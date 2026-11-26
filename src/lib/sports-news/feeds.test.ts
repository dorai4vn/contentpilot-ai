import { describe, expect, it } from "vitest";
import { parseSportsFeed } from "./feeds";
import { calculateNewsScore } from "./scoring";

const source = { name: "Tuổi Trẻ", url: "https://tuoitre.vn/rss/the-thao.rss" };
const now = Date.parse("2026-11-26T20:00:00+07:00");

describe("sports news RSS", () => {
  it("normalizes Vietnamese feed dates, HTML and source URLs", () => {
    const xml = `<rss><channel><item>
      <title><![CDATA[B&oacute;ng đ&aacute; Việt Nam]]></title>
      <description><![CDATA[<p>Tin về chung kết.</p>]]></description>
      <link><![CDATA[https://tuoitre.vn/the-thao.htm?utm_source=rss#x]]></link>
      <pubDate>11/26/2026 7:00:00 PM</pubDate>
    </item></channel></rss>`;
    expect(parseSportsFeed(xml, source, now)).toEqual([{
      title: "Bóng đá Việt Nam",
      summary: "Tin về chung kết.",
      source: "Tuổi Trẻ",
      url: "https://tuoitre.vn/the-thao.htm",
      publishedAt: Date.parse("2026-11-26T19:00:00+07:00"),
    }]);
    expect(parseSportsFeed(xml, source, now + 3 * 24 * 60 * 60 * 1000)).toEqual([]);
    expect(parseSportsFeed(xml.replace("tuoitre.vn/the-thao", "example.org/the-thao"), source, now)).toEqual([]);
  });

  it("rejects document types and external entities", () => {
    expect(() => parseSportsFeed("<!DOCTYPE rss><rss><channel/></rss>", source, now)).toThrow("invalid_sports_feed");
  });
});

describe("sports news scoring", () => {
  const assessment = { playerPopularity: 2, teamPopularity: 8, competitionPopularity: 9, eventImportance: 9, reason: "Chung kết" };

  it("ranks a major current event above the default threshold and reduces the rank with age", () => {
    expect(calculateNewsScore(assessment, now, now)).toBe(9.2);
    expect(calculateNewsScore(assessment, now - 48 * 60 * 60 * 1000, now)).toBe(7.7);
    expect(calculateNewsScore({ ...assessment, eventImportance: 3 }, now, now)).toBeLessThan(8);
  });
});
