import type { Metadata } from "next";

import { FootballNewsList } from "../../_components/football-news-list";
import { SemanticEventLog } from "../../_components/semantic-event-log";
import { recentEventDecisions, recentFootballNews } from "../../_lib/football-news";
import { loadWorkspace } from "../../_lib/load";

export const metadata: Metadata = { title: "Luồng tin bóng đá" };

export default async function NewsFeedPage({ params }: PageProps<"/w/[workspaceId]/news">) {
  const { workspaceId } = await params;
  const { workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/news`);
  const [news, decisions] = await Promise.all([recentFootballNews(workspace.id, 30), recentEventDecisions(workspace.id, 20)]);
  return (
    <div className="football-page">
      <div className="football-page-header">
        <div><p className="football-eyebrow">Football News Control Center</p><h1>Luồng tin</h1><p>30 tin RSS được ghi nhận gần nhất.</p></div>
      </div>
      <section className="football-panel" aria-label="Tin RSS gần đây"><FootballNewsList items={news} workspaceId={workspace.id} /></section>
      <section className="football-panel" aria-label="Nhật ký trùng sự kiện">
        <div className="football-panel-heading"><div><h2>Nhật ký trùng sự kiện</h2><p>Tin bị bỏ qua vì trùng sự kiện hoặc được nối tiếp, kèm lý do.</p></div></div>
        <SemanticEventLog items={decisions} />
      </section>
    </div>
  );
}
