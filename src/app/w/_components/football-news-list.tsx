import { ArrowUpRight, Image as ImageIcon } from "lucide-react";
import Link from "next/link";

import type { recentFootballNews } from "../_lib/football-news";

type News = Awaited<ReturnType<typeof recentFootballNews>>;

export function FootballNewsList({ items, workspaceId }: { items: News; workspaceId: string }) {
  if (!items.length) return <div className="football-empty">Chưa có tin RSS trong không gian này.</div>;
  return (
    <ul className="football-news-list">
      {items.map((item) => (
        <li key={item.source_url} className="football-news-row">
          <div className="football-news-main">
            <div className="football-news-meta">
              <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" })}</time>
              <span aria-hidden="true">·</span><span>{new URL(item.source_url).hostname}</span>
              {item.has_image ? <span className="football-image-indicator" title="Có ảnh"><ImageIcon size={14} aria-label="Có ảnh" /></span> : null}
            </div>
            <h2>{item.post_id ? <Link href={`/w/${workspaceId}/posts/${item.post_id}`}>{item.title}</Link> : item.title}</h2>
            <a href={item.source_url} target="_blank" rel="noopener noreferrer" className="football-source-link">
              Bài gốc <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          </div>
          <div className="football-score" aria-label={`Độ hot ${item.score} trên 10`}><strong>{item.score}</strong><span>/10</span></div>
        </li>
      ))}
    </ul>
  );
}
