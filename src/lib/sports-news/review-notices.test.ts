import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, expect, it, vi } from "vitest";

import type { Database } from "@/types/database";
import { sendReviewNotices } from "./review-notices";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllGlobals());

it.each([true, false])("records Telegram acknowledgement (%s) and links the exact pending request", async (acknowledged) => {
  const rpc = vi.fn()
    .mockResolvedValueOnce({
      data: [{ post_id: "post", claim_id: "claim", title: "Tin thể thao", score: 8.5, request_ids: ["request"] }],
      error: null,
    })
    .mockResolvedValueOnce({ data: true, error: null });
  const client = { rpc } as unknown as SupabaseClient<Database>;
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: acknowledged }));
  vi.stubGlobal("fetch", send);

  const result = await sendReviewNotices(client, "workspace", "project", {
    botToken: "123:token", chatId: "456", siteOrigin: "https://contentpilot.example",
  });

  const payload = JSON.parse(String(send.mock.calls[0][1]?.body));
  expect(payload).toMatchObject({ chat_id: "456" });
  expect(payload.text).toContain("https://contentpilot.example/w/workspace/approvals/request");
  expect(payload.text).toContain("8.5/10");
  expect(rpc).toHaveBeenLastCalledWith("finish_sports_news_review_notice", {
    p_workspace_id: "workspace", p_post_id: "post", p_claim_id: "claim", p_sent: acknowledged,
  });
  expect(result.reviewNoticesSent).toBe(acknowledged ? 1 : 0);
  expect(result.reviewNoticeFailures).toBe(acknowledged ? 0 : 1);
});
