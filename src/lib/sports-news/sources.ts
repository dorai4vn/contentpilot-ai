export type SportsFeedSource = {
  name: string;
  url: string;
  section?: string;
  localDateFormat?: "year-first";
};

export const sportsFeeds: readonly SportsFeedSource[] = [
  { name: "Bóng Đá 24h", section: "Cúp C1", url: "https://bongda24h.vn/RSS/488.rss", localDateFormat: "year-first" },
  { name: "Bóng Đá 24h", section: "Bóng đá Anh", url: "https://bongda24h.vn/RSS/172.rss", localDateFormat: "year-first" },
  { name: "Bóng Đá 24h", section: "Việt Nam", url: "https://bongda24h.vn/RSS/168.rss", localDateFormat: "year-first" },
  { name: "Bóng Đá 24h", section: "Tin mới", url: "https://bongda24h.vn/RSS/1.rss", localDateFormat: "year-first" },
  { name: "BongDa.com.vn", url: "https://bongda.com.vn/feed.rss" },
  { name: "Thể Thao 247", section: "Ngoại hạng Anh", url: "https://thethao247.vn/ngoai-hang-anh-c8.rss" },
  { name: "Thể Thao 247", section: "Cúp C1", url: "https://thethao247.vn/cup-c1-c13.rss" },
  { name: "Thể Thao 247", section: "Quốc tế", url: "https://thethao247.vn/bong-da-quoc-te-c2.rss" },
  { name: "Thể Thao 247", section: "Việt Nam", url: "https://thethao247.vn/bong-da-viet-nam-c1.rss" },
  { name: "Tuổi Trẻ", url: "https://tuoitre.vn/rss/the-thao.rss" },
  { name: "Thanh Niên", url: "https://thanhnien.vn/rss/the-thao.rss" },
];

const origins = new Set(sportsFeeds.map((feed) => new URL(feed.url).origin));

export function isSportsNewsSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return origins.has(url.origin) && !url.username && !url.password;
  } catch {
    return false;
  }
}
