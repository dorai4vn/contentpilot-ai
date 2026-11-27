import { ArrowRight, Newspaper } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { FootballNewsList } from "../_components/football-news-list";
import { recentFootballNews } from "../_lib/football-news";
import { loadWorkspace } from "../_lib/load";

export const metadata: Metadata = { title: "Football News Control Center" };

export default async function FootballOverview({ params }: PageProps<"/w/[workspaceId]">) {
  const { workspaceId } = await params;
  const { workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}`);
  const news = await recentFootballNews(workspace.id, 6);

  return (
    <div className="football-page">
      <div className="football-page-header">
        <div>
          <p className="football-eyebrow">Football News Control Center</p>
          <h1>Tổng quan</h1>
          <p>Tin bóng đá mới được hệ thống quét trong {workspace.name}.</p>
        </div>
        <Link href={`/w/${workspace.id}/news`} className="football-action">Xem luồng tin <ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
      <section className="football-panel" aria-labelledby="latest-news-title">
        <div className="football-panel-heading">
          <span className="football-panel-icon"><Newspaper size={19} aria-hidden="true" /></span>
          <div><h2 id="latest-news-title">Tin mới nhất</h2><p>Dữ liệu RSS đã được ghi nhận</p></div>
        </div>
        <FootballNewsList items={news} workspaceId={workspace.id} />
      </section>
    </div>
  );
}
