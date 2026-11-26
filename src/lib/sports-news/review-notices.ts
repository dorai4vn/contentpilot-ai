import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { contentPaths } from "@/lib/content/paths";
import type { Database } from "@/types/database";

const noticeConfig = z.object({
  botToken: z.string().regex(/^\d+:[\w-]+$/),
  chatId: z.string().regex(/^[1-9]\d{0,19}$/),
  siteOrigin: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash;
  }),
});

export function readReviewNoticeConfig() {
  const botToken = process.env.SPORTS_NEWS_REVIEW_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.SPORTS_NEWS_REVIEW_TELEGRAM_CHAT_ID?.trim();
  const siteOrigin = process.env.SPORTS_NEWS_REVIEW_SITE_ORIGIN?.trim();
  if (!botToken && !chatId && !siteOrigin) return null;
  return noticeConfig.parse({ botToken, chatId, siteOrigin });
}

type NoticeConfig = NonNullable<ReturnType<typeof readReviewNoticeConfig>>;
type Notice = Database["public"]["Functions"]["claim_sports_news_review_notices"]["Returns"][number];

async function notify(config: NoticeConfig, workspaceId: string, notice: Notice): Promise<boolean> {
  const queue = contentPaths.approvals(workspaceId);
  const links = notice.request_ids.slice(0, 5).map((id, index) => {
    const url = new URL(`${queue}/${id}`, config.siteOrigin);
    return notice.request_ids.length === 1 ? `Mở bài để duyệt: ${url}` : `Đích ${index + 1}: ${url}`;
  });
  if (notice.request_ids.length > links.length) {
    links.push(`Tất cả yêu cầu: ${new URL(queue, config.siteOrigin)}`);
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: ["ContentPilot AI · Tin thể thao chờ duyệt", notice.title, `Độ hot: ${notice.score}/10`, "", ...links].join("\n"),
        link_preview_options: { is_disabled: true },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

export async function sendReviewNotices(
  client: SupabaseClient<Database>,
  workspaceId: string,
  projectId: string,
  config: NoticeConfig | null,
) {
  if (!config) return { reviewNoticesConfigured: false, reviewNoticesSent: 0, reviewNoticeFailures: 0 };

  const { data, error } = await client.rpc("claim_sports_news_review_notices", {
    p_workspace_id: workspaceId, p_project_id: projectId,
  });
  if (error) throw new Error("sports_news_review_claim_failed");

  const results = await Promise.allSettled(data.map(async (notice) => {
    const sent = await notify(config, workspaceId, notice);
    const record = await client.rpc("finish_sports_news_review_notice", {
      p_workspace_id: workspaceId, p_post_id: notice.post_id, p_claim_id: notice.claim_id, p_sent: sent,
    });
    return sent && !record.error && record.data;
  }));
  const reviewNoticesSent = results.filter((result) => result.status === "fulfilled" && result.value).length;
  return { reviewNoticesConfigured: true, reviewNoticesSent, reviewNoticeFailures: data.length - reviewNoticesSent };
}
