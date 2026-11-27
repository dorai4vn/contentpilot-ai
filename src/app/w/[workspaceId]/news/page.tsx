import type { Metadata } from "next";

import { FootballNewsList } from "../../_components/football-news-list";
import { recentFootballNews } from "../../_lib/football-news";
import { loadWorkspace } from "../../_lib/load";

export const metadata: Metadata = { title: "Luồng tin bóng đá" };

export default async function NewsFeedPage({ params }: PageProps<"/w/[workspaceId]/news">) {
  const { workspaceId } = await params;
  const { workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/news`);
  const news = await recentFootballNews(workspace.id, 30);
  return (
    <div className="football-page">
      <div className="football-page-header">
        <div><p className="football-eyebrow">Football News Control Center</p><h1>Luồng tin</h1><p>30 tin RSS được ghi nhận gần nhất.</p></div>
      </div>
      <section className="football-panel" aria-label="Tin RSS gần đây"><FootballNewsList items={news} workspaceId={workspace.id} /></section>
    </div>
  );
}
