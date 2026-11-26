import { expect, it, vi } from "vitest";
import { writeSportsDraft } from "./editor";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/config", () => ({
  getOpenAIConfig: () => ({ model: "test-model" }),
  createOpenAIClient: () => ({ chat: { completions: { create: complete } } }),
}));

it("requests a compact, source-grounded social caption and preserves emojis and paragraph breaks", async () => {
  const caption = {
    title: "🏆 Hà Nội FC vào chung kết",
    body: "Hà Nội FC thắng 2–1 ở bán kết. ⚽\n\nBàn quyết định đến ở phút 88.",
    photoSubject: "Hà Nội FC",
  };
  complete.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(caption) } }] });
  const item = {
    source: "Báo thể thao", url: "https://example.com/fixture",
    title: "Hà Nội FC vào chung kết", summary: "Thắng 2–1 nhờ bàn ở phút 88.", publishedAt: 0,
  };

  await expect(writeSportsDraft(item)).resolves.toEqual(caption);

  const messages = complete.mock.calls[0][0].messages;
  expect(messages[0].content).toContain("2–3 đoạn ngắn");
  expect(messages[0].content).toContain("emoji đúng ngữ cảnh");
  expect(messages[0].content).toContain("Chỉ dùng dữ kiện");
  expect(JSON.parse(messages[1].content)).toMatchObject({ title: item.title, summary: item.summary });
});
