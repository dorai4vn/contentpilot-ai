import { beforeEach, expect, it, vi } from "vitest";
import { countEmoji, writeSportsDraft } from "./editor";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/config", () => ({
  getOpenAIConfig: () => ({ model: "test-model" }),
  createOpenAIClient: () => ({ chat: { completions: { create: complete } } }),
}));
beforeEach(() => complete.mockReset());

/**
 * Fixture ngoại tuyến (KHÔNG phải đầu ra mô hình thật, không gọi API trả phí). "before" mô phỏng hành vi sau PR #32
 * (prompt ba lần nhấn "tùy chọn / có thể không dùng" → mô hình bỏ emoji hoàn toàn); "after" là caption mẫu do biên tập
 * viết theo hướng dẫn prompt mới, dùng để kiểm tra pipeline giữ nguyên emoji ngữ cảnh và để đo phân bố.
 */
type Fixture = { topic: string; sensitive?: boolean; before: [string, string]; after: [string, string] };
const FIXTURES: Fixture[] = [
  { topic: "kết quả Champions League",
    before: ["Lille hạ Bayern 1–0 ở C1", "Bàn duy nhất ở phút 90+2 giúp Lille thắng Bayern."],
    after: ["Lille hạ Bayern 1–0 ở C1", "Bàn duy nhất ở phút 90+2 giúp Lille thắng Bayern ⚽\n\nĐây là trận thua đầu tiên của Bayern mùa này."] },
  { topic: "chuyển nhượng",
    before: ["Real chốt hợp đồng với tiền vệ trẻ", "Real Madrid đạt thỏa thuận 5 năm, phí 60 triệu euro."],
    after: ["✍️ Real chốt hợp đồng với tiền vệ trẻ", "Real Madrid đạt thỏa thuận 5 năm, phí 60 triệu euro.\n\nCầu thủ sẽ khám sức khỏe vào tuần tới."] },
  { topic: "chức vô địch",
    before: ["Man City vô địch Premier League", "Man City giành chức vô địch lần thứ 9 sau trận hòa 1-1."],
    after: ["Man City vô địch Premier League", "Sau trận hòa 1-1, Man City nâng chiếc cúp thứ 9 trong lịch sử 🏆\n\nHọ hơn Arsenal 2 điểm khi còn một vòng."] },
  { topic: "chấn thương nặng", sensitive: true,
    before: ["Son dính chấn thương", "Son rời sân ở phút 30, thời gian vắng mặt chưa được công bố."],
    after: ["Son dính chấn thương", "Son rời sân ở phút 30, thời gian vắng mặt chưa được công bố."] },
  { topic: "thẻ đỏ / kỷ luật",
    before: ["Thẻ đỏ làm đổi cục diện derby", "Hậu vệ nhận thẻ đỏ phút 55, đội nhà chơi thiếu người."],
    after: ["Thẻ đỏ làm đổi cục diện derby", "Hậu vệ nhận thẻ đỏ phút 55 🟥 Đội nhà phải chơi thiếu người suốt 35 phút còn lại."] },
  { topic: "đội tuyển Việt Nam",
    before: ["Việt Nam thắng Lào 3–0", "Ba bàn thắng đến trong hiệp hai."],
    after: ["Việt Nam thắng Lào 3–0 🇻🇳", "Ba bàn thắng đến trong hiệp hai.\n\nTuyển Việt Nam dẫn đầu bảng sau lượt đầu."] },
  { topic: "lịch thi đấu",
    before: ["Lịch bán kết cúp quốc gia", "Hai lượt bán kết diễn ra ngày 12 và 19/3."],
    after: ["Lịch bán kết cúp quốc gia", "Hai lượt bán kết diễn ra ngày 12 và 19/3 🗓️ Trận chung kết dự kiến vào cuối tháng 5."] },
  { topic: "HLV / họp báo",
    before: ["HLV Arteta nói về cuộc đua", "Arteta cho biết đội sẽ tập trung vào từng trận."],
    after: ["HLV Arteta nói về cuộc đua", "Arteta cho biết đội sẽ tập trung vào từng trận.\n\n\"Chúng tôi chỉ nghĩ đến trận tới\" 🎙️ ông nói thêm."] },
  { topic: "kỷ lục cá nhân",
    before: ["Haaland cán mốc 100 bàn", "Haaland ghi bàn thứ 100 cho Man City ở trận thứ 105."],
    after: ["Haaland cán mốc 100 bàn", "Haaland ghi bàn thứ 100 cho Man City ở trận thứ 105 🎯\n\nChưa cầu thủ nào của CLB đạt mốc này nhanh hơn."] },
  { topic: "tang sự", sensitive: true,
    before: ["Cựu danh thủ qua đời ở tuổi 78", "CLB gửi lời chia buồn tới gia đình."],
    after: ["Cựu danh thủ qua đời ở tuổi 78", "CLB gửi lời chia buồn tới gia đình."] },
  { topic: "hòa kịch tính",
    before: ["Liverpool bị cầm hòa 2–2", "Hai lần dẫn trước, hai lần bị gỡ. Liverpool kém đầu bảng 3 điểm."],
    after: ["Liverpool bị cầm hòa 2–2", "Hai lần dẫn trước, hai lần bị gỡ.\n\nLiverpool kém đầu bảng 3 điểm 📉"] },
  { topic: "thời tiết / hoãn trận",
    before: ["Trận đấu bị hoãn vì bão", "Ban tổ chức hoãn trận sang chiều mai."],
    after: ["Trận đấu bị hoãn vì bão", "⛈️ Ban tổ chức hoãn trận sang chiều mai vì lý do an toàn."] },
];

const item = (title: string, summary: string) => ({ source: "Báo thể thao", url: "https://example.com/x", title, summary, publishedAt: 0 });
async function run(batch: "before" | "after") {
  const out: { topic: string; sensitive: boolean; title: string; body: string; text: string }[] = [];
  for (const f of FIXTURES) {
    const [title, body] = f[batch];
    complete.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ title, body, photoSubject: null, matchPhoto: null }) } }] });
    const r = await writeSportsDraft(item(title, body));
    out.push({ topic: f.topic, sensitive: !!f.sensitive, title: r.title, body: r.body, text: `${r.title}\n\n${r.body}` });
  }
  return out;
}
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/gu;
const emojiOf = (text: string) => [...text.matchAll(EMOJI_RE)].map((m) => m[0]);
const position = (r: { title: string; body: string }) => {
  if (emojiOf(r.title).length) return "title";
  const m = r.body.match(EMOJI_RE)?.[0];
  if (!m) return "none";
  const i = r.body.indexOf(m);
  if (i === 0 || r.body[i - 1] === "\n") return "paragraph-start";
  const rest = r.body.slice(i + m.length);
  return rest === "" ? "end" : /^\s*(\n|$)/.test(rest) ? "paragraph-end" : "mid-paragraph";
};

it("pipeline never injects emoji: the PR #32 'before' batch stays emoji-free, facts preserved", async () => {
  const before = await run("before");
  expect(before.every((r) => emojiOf(r.text).length === 0)).toBe(true);
  before.forEach((r, i) => { expect(r.title).toBe(FIXTURES[i].before[0]); });
});

it("normal path: contextual emoji survive normalization, caption substance is unchanged", async () => {
  const after = await run("after");
  after.forEach((r, i) => {
    const [title, body] = FIXTURES[i].after;
    expect(r.title).toBe(title);
    expect(r.body).toBe(body);
    expect(countEmoji(r.title)).toBeLessThanOrEqual(1);
    expect(countEmoji(r.body)).toBeLessThanOrEqual(3);
  });
});

it("after-batch distribution: not blanket-omitted, not a repeated template, sensitive topics stay plain", async () => {
  const after = await run("after");
  const withEmoji = after.filter((r) => emojiOf(r.text).length > 0);
  const ratio = withEmoji.length / after.length;
  const distinct = new Set(withEmoji.flatMap((r) => emojiOf(r.text)));
  const positions = new Set(after.map(position));
  const dist = { posts: after.length, withEmoji: withEmoji.length, ratio: Number(ratio.toFixed(2)), distinct: distinct.size, positions: [...positions].sort() };
  console.info("emoji distribution (after):", JSON.stringify(dist));
  expect(ratio).toBeGreaterThanOrEqual(0.6);
  expect(ratio).toBeLessThan(1); // một số bài vẫn được bỏ emoji khi hợp biên tập
  expect(distinct.size).toBeGreaterThanOrEqual(8);
  expect(positions.size).toBeGreaterThanOrEqual(4);
  // không có biểu tượng nào chiếm quá 2 bài
  for (const e of distinct) expect(withEmoji.filter((r) => emojiOf(r.text).includes(e)).length).toBeLessThanOrEqual(2);
  for (const r of after.filter((x) => x.sensitive)) expect(emojiOf(r.text)).toHaveLength(0);
  // bản in cho người đọc (xem bằng `npx vitest run emoji-regression --reporter=verbose`)
  console.info(after.map((r) => `[${r.topic}] ${r.title} | ${position(r)}`).join("\n"));
});

it("fallback: plain reply stays plain and an emoji flood is capped without orphan fragments", async () => {
  complete.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
    title: "⚽️🔥 Arsenal thắng", body: "Arsenal thắng 1–0 ⚽️ 🏆 👀 🔥 🇻🇳.", photoSubject: null, matchPhoto: null }) } }] });
  const r = await writeSportsDraft(item("a", "b"));
  expect(countEmoji(r.title)).toBe(1);
  expect(countEmoji(r.body)).toBe(3);
  expect(r.title).not.toMatch(/️\s*🔥/u);
  expect(r.body).not.toMatch(/ \./);
  expect(r.body).toContain("Arsenal thắng 1–0");
});

it("countEmoji counts ZWJ sequences, variation selectors and flags as one each", () => {
  expect(countEmoji("⚽️ 🇻🇳 👨‍👩‍👧 abc 🏆")).toBe(4);
  expect(countEmoji("Không có emoji, chỉ có chữ Việt")).toBe(0);
});
