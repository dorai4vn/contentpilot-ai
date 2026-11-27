import { beforeEach, expect, it, vi } from "vitest";
import { writeSportsDraft } from "./editor";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/config", () => ({
  getOpenAIConfig: () => ({ model: "test-model" }),
  createOpenAIClient: () => ({ chat: { completions: { create: complete } } }),
}));
beforeEach(() => complete.mockReset());

const item = (title: string, summary: string) => ({
  source: "Báo thể thao", url: "https://example.com/x", title, summary, publishedAt: 0,
});
const reply = (caption: object) => complete.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(caption) } }] });
const base = { photoSubject: null, matchPhoto: null };

it("prompt asks for varied structure, optional emoji and no fixed pattern", async () => {
  reply({ ...base, title: "Hà Nội FC vào chung kết", body: "Thắng 2–1 nhờ bàn phút 88." });
  await writeSportsDraft(item("Hà Nội FC vào chung kết", "Thắng 2–1 nhờ bàn ở phút 88."));
  const system: string = complete.mock.calls[0][0].messages[0].content;
  expect(system).toContain("Chỉ dùng dữ kiện");
  expect(system).toContain("Emoji là tùy chọn");
  expect(system).toContain("KHÔNG theo khuôn cố định");
  expect(system).toContain("Không bịa cảm xúc");
  expect(system).not.toContain("Mỗi đoạn bắt đầu");
  expect(system).not.toMatch(/⚡ cho diễn biến|📉 cho hệ quả/);
  expect(system).not.toContain("một emoji mở đầu");
});

it("does not inject 🔥/⚡/👀 or paragraph structure into varied captions", async () => {
  const captions = [
    { title: "Lille hạ Bayern 1–0 ở C1", body: "Bàn duy nhất ở phút 90+2 giúp Lille thắng Bayern." }, // tin nhanh, không emoji
    { title: "Liverpool bị cầm hòa 2–2", body: "Hai lần dẫn trước, hai lần bị gỡ.\n\nKết quả khiến Liverpool kém đầu bảng 3 điểm. 📉\n\nHLV sẽ họp báo vào chiều mai." },
    { title: "⚽ Việt Nam thắng Lào 3–0", body: "Ba bàn thắng đến trong hiệp hai." },
    { title: "Chấn thương của Son", body: "Bối cảnh: Son rời sân ở phút 30.\nTheo nguồn tin, thời gian vắng mặt chưa được công bố." },
  ];
  const results = [];
  for (const c of captions) {
    reply({ ...base, ...c });
    results.push(await writeSportsDraft(item(c.title, c.body)));
  }
  for (const [i, r] of results.entries()) {
    expect(r.title).toBe(captions[i].title);
    expect(r.body).toBe(captions[i].body);
    expect(`${r.title}${r.body}`).not.toMatch(/🔥|⚡|👀/);
  }
  // không có mẫu "mỗi đoạn một emoji mở đầu"; số đoạn khác nhau
  expect(new Set(results.map((r) => r.body.split("\n\n").length)).size).toBeGreaterThan(1);
  expect(results[0].title).not.toMatch(/^\p{Extended_Pictographic}/u);
});

it("fallback: a plain model reply without emoji stays plain (no forced prefix) and keeps facts", async () => {
  reply({ ...base, title: "Man City vô địch", body: "Man City giành chức vô địch sau trận hòa 1-1.\n\n\n\nĐây là lần thứ 9 của CLB." });
  const r = await writeSportsDraft(item("Man City vô địch", "Hòa 1-1."));
  expect(r.title).toBe("Man City vô địch");
  expect(r.body).toBe("Man City giành chức vô địch sau trận hòa 1-1.\n\nĐây là lần thứ 9 của CLB.");
  expect(r.photoNeedsAction).toBe(true);
});

it("strips markdown markers (Telegram bold is applied by delivery) and caps emoji spam", async () => {
  reply({ ...base, title: "🔥🔥 **Arsenal** thắng", body: "⚡ *Arsenal* thắng 1–0 ⚽🏆👀🔥" });
  const r = await writeSportsDraft(item("Arsenal thắng", "1–0"));
  expect(r.title).not.toMatch(/[*_`#]/);
  expect(r.body).not.toMatch(/[*_`#]/);
  expect(r.title.match(/\p{Extended_Pictographic}/gu)?.length).toBe(1);
  expect(r.body.match(/\p{Extended_Pictographic}/gu)?.length).toBeLessThanOrEqual(3);
  expect(r.body).toContain("Arsenal thắng 1–0");
});

it("still rejects oversized or invalid drafts and passes provider errors", async () => {
  reply({ ...base, title: "x".repeat(81), body: "ok" });
  await expect(writeSportsDraft(item("a", "b"))).rejects.toThrow();
  complete.mockResolvedValueOnce({ choices: [{ message: { content: "" } }] });
  await expect(writeSportsDraft(item("a", "b"))).rejects.toThrow("sports_editor_empty_response");
});
