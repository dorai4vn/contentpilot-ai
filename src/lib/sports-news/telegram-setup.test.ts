import { afterEach, expect, it, vi } from "vitest";
import { inspectTelegramSetup } from "./telegram-setup";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllGlobals());

it("discovers only channels where the bot can post, without acknowledging updates or sending messages", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const method = String(url).split("/").at(-1);
    const params = JSON.parse(String(init?.body));
    const answer = (result: unknown) => Response.json({ ok: true, result });
    if (method === "getMe") return answer({ id: 22 });
    if (method === "getChat") return answer({ id: 10, type: "private" });
    if (method === "getUpdates") {
      expect(params).not.toHaveProperty("offset");
      return answer([
        { my_chat_member: { chat: { id: -100123456, type: "channel", title: "Sports" } } },
        { channel_post: { chat: { id: -100987654, type: "channel", title: "Other" } } },
        { my_chat_member: { chat: { id: -100678901, type: "supergroup" } } },
      ]);
    }
    expect(method).toBe("getChatMember");
    return answer({ status: "administrator", can_post_messages: params.chat_id === -100123456 });
  });
  vi.stubGlobal("fetch", send);
  await expect(inspectTelegramSetup("22:token", "10")).resolves.toEqual({
    botValid: true, reviewChatReachable: true, discoveryAvailable: true,
    channels: [{ id: "-100123456", title: "Sports", username: undefined }],
  });
});
