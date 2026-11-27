import { beforeEach, expect, it, vi } from "vitest";
import { SPORTS_CAPTION_BUDGET, writeSportsDraft } from "./editor";
import { socialPublisher } from "@/lib/publishing/adapters/social";

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

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const sentence = (n: number) => `Câu số ${n} nêu diễn biến cụ thể của trận đấu giữa hai đội ở vòng đấu này.`;
const para = (from: number, count: number) => Array.from({ length: count }, (_, i) => sentence(from + i)).join(" ");

it("prompt drops the 1–2 sentence / 620 rule, sets word targets and the shared platform budget", async () => {
  reply({ ...base, title: "Tin", body: "Nội dung." });
  await writeSportsDraft(item("Tin", "Nội dung."));
  const { messages, max_completion_tokens } = complete.mock.calls[0][0];
  const system: string = messages[0].content;
  expect(system).not.toMatch(/620|mỗi đoạn 1–2 câu/);
  expect(system).toMatch(/50–80 từ/);
  expect(system).toMatch(/80–110 từ/);
  expect(system).toMatch(/110–140 từ/);
  expect(system).toMatch(/160–170 từ/);
  expect(system).not.toMatch(/180–250|150–220|120–180|180–250 từ/);
  expect(system).toContain("KHÔNG phải mức tối thiểu");
  expect(system).toContain(`${SPORTS_CAPTION_BUDGET} ký tự`);
  expect(system).toContain("không độn chữ");
  expect(system).toContain("không để cụt giữa câu");
  expect(max_completion_tokens).toBeLessThanOrEqual(1100); // không tăng chi phí đầu ra
});

it("keeps a realistic full-length multi-paragraph Vietnamese caption intact and within budget", async () => {
  const body = [para(1, 3), para(4, 3), para(7, 2)].join("\n\n");
  const title = "Lille hạ Bayern ở Champions League";
  expect(words(body)).toBeGreaterThan(100);
  reply({ ...base, title, body });
  const r = await writeSportsDraft(item(title, "x"));
  expect(r.body).toBe(body);
  expect(r.body.split("\n\n")).toHaveLength(3);
  expect(`${r.title}\n\n${r.body}`.length).toBeLessThanOrEqual(SPORTS_CAPTION_BUDGET);
});

it("sparse input stays short: no filler is added", async () => {
  reply({ ...base, title: "Son dính chấn thương", body: "Son rời sân ở phút 30." });
  const r = await writeSportsDraft(item("Son dính chấn thương", "Son rời sân."));
  expect(r.body).toBe("Son rời sân ở phút 30.");
});

it("over-budget body is cut at paragraph/sentence boundary, never mid-sentence", async () => {
  const title = "Tin lớn";
  const body = [para(1, 5), para(6, 5), para(11, 5)].join("\n\n");
  expect(body.length).toBeGreaterThan(SPORTS_CAPTION_BUDGET);
  reply({ ...base, title, body });
  const r = await writeSportsDraft(item(title, "x"));
  expect(`${r.title}\n\n${r.body}`.length).toBeLessThanOrEqual(SPORTS_CAPTION_BUDGET);
  expect(r.body.endsWith(".")).toBe(true);
  expect(body.startsWith(r.body)).toBe(true);
  // chỉ gồm các câu nguyên vẹn
  for (const s of r.body.split(/\n\n|(?<=\.)\s/)) expect(s).toMatch(/^Câu số \d+ .*\.$/);
});

it("a single over-long paragraph is trimmed to whole sentences", async () => {
  reply({ ...base, title: "T", body: para(1, 14) });
  const r = await writeSportsDraft(item("T", "x"));
  expect(r.body.length).toBeLessThanOrEqual(SPORTS_CAPTION_BUDGET - 3);
  expect(r.body.endsWith("trận đấu giữa hai đội ở vòng đấu này.")).toBe(true);
});

it("counts emoji surrogate pairs in UTF-16 units against the budget", async () => {
  const title = "⚽ Chung kết";
  const body = Array.from({ length: 60 }, () => "Bàn thắng đẹp. 🏆").join(" ");
  reply({ ...base, title, body });
  const r = await writeSportsDraft(item(title, "x"));
  expect(`${r.title}\n\n${r.body}`.length).toBeLessThanOrEqual(SPORTS_CAPTION_BUDGET);
  expect(r.body.match(/\p{Extended_Pictographic}/gu)?.length).toBeLessThanOrEqual(3);
});

it("normalizes decomposed Vietnamese diacritics to NFC so length is not inflated", async () => {
  const nfd = "Việt Nam thắng".normalize("NFD");
  reply({ ...base, title: nfd, body: nfd });
  const r = await writeSportsDraft(item("a", "b"));
  expect(r.title).toBe("Việt Nam thắng");
  expect(r.body).toBe("Việt Nam thắng");
});

it("rejects captions that are empty after normalization", async () => {
  reply({ ...base, title: "Tin", body: "**__**" });
  await expect(writeSportsDraft(item("a", "b"))).rejects.toThrow("sports_editor_empty_caption");
  reply({ ...base, title: "***", body: "Nội dung" });
  await expect(writeSportsDraft(item("a", "b"))).rejects.toThrow("sports_editor_empty_caption");
});

it("a normalized full caption is accepted by Telegram photo delivery with correct bold title entity", async () => {
  const title = "⚽ Lille hạ Bayern";
  reply({ ...base, title, body: [para(1, 5), para(6, 5)].join("\n\n") });
  const draft = await writeSportsDraft(item(title, "x"));
  const adapter = socialPublisher("telegram");
  const payload = adapter.render({ title: draft.title, body: draft.body, image: new Uint8Array([1, 2, 3]) } as never);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })));
  const outcome = await adapter.publish(payload, {
    targetRef: "-1001234567890", credentials: { reveal: () => "123:abc" }, idempotencyKey: "k",
  } as never);
  expect(outcome).toEqual({ ok: true, externalId: "7" });
  expect(fetchMock).toHaveBeenCalledTimes(1); // một bài, không gửi thêm tin nhắn
  const form = fetchMock.mock.calls[0][1]!.body as FormData;
  expect(String(fetchMock.mock.calls[0][0])).toContain("sendPhoto");
  expect(JSON.parse(String(form.get("caption_entities")))).toEqual([{ type: "bold", offset: 0, length: draft.title.length }]);
  expect(String(form.get("caption")).startsWith(draft.title)).toBe(true);
  expect(String(form.get("caption")).length).toBeLessThanOrEqual(1024);
  fetchMock.mockRestore();
});
