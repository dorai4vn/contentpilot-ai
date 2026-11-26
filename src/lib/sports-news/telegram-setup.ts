import "server-only";

import { z } from "zod";

const chatSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  title: z.string().optional(),
  username: z.string().optional(),
});

async function telegram<T>(token: string, method: string, schema: z.ZodType<T>, body = {}) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const result = z.object({ ok: z.literal(true), result: schema }).safeParse(await response.json());
    return result.success ? result.data.result : null;
  } catch {
    return null;
  }
}

export async function inspectTelegramSetup(token: string, reviewChatId: string, channelUsername?: string) {
  const updatesSchema = z.array(z.object({
    my_chat_member: z.object({ chat: chatSchema }).optional(),
    channel_post: z.object({ chat: chatSchema }).optional(),
    edited_channel_post: z.object({ chat: chatSchema }).optional(),
  }));
  const [bot, reviewChat, updates, namedChannel] = await Promise.all([
    telegram(token, "getMe", z.object({ id: z.number().int() })),
    telegram(token, "getChat", chatSchema, { chat_id: reviewChatId }),
    channelUsername ? null : telegram(token, "getUpdates", updatesSchema, { limit: 100, timeout: 0 }),
    channelUsername ? telegram(token, "getChat", chatSchema, { chat_id: channelUsername }) : null,
  ]);

  const channels = new Map<number, z.infer<typeof chatSchema>>();
  for (const update of updates ?? []) {
    const chat = update.channel_post?.chat ?? update.edited_channel_post?.chat ?? update.my_chat_member?.chat;
    if (chat?.type === "channel") channels.set(chat.id, chat);
  }
  if (namedChannel?.type === "channel") channels.set(namedChannel.id, namedChannel);
  const allowed = bot ? await Promise.all([...channels.values()].map(async (channel) => {
    const membership = await telegram(token, "getChatMember",
      z.object({ status: z.string(), can_post_messages: z.boolean().optional() }),
      { chat_id: channel.id, user_id: bot.id });
    if (membership?.status === "administrator" && membership.can_post_messages === true) {
      return { id: String(channel.id), title: channel.title, username: channel.username };
    }
    return null;
  })) : [];

  return {
    botValid: bot !== null,
    reviewChatReachable: reviewChat?.type === "private",
    discoveryAvailable: channelUsername ? namedChannel !== null : updates !== null,
    channels: allowed.filter((channel) => channel !== null),
  };
}
