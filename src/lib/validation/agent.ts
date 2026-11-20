import { z } from "zod";

/**
 * Chat history sent to the agent. It comes from the browser and is untrusted:
 * it only shapes the conversation, never permissions (those are enforced by the
 * tool executor and the database). Sizes are capped to bound cost.
 */

export const AGENT_CHAT_LIMITS = {
  maxMessages: 20,
  maxMessageLength: 4000,
} as const;

export const agentChatMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z
    .string()
    .trim()
    .min(1, { message: "Tin nhắn không được để trống." })
    .max(AGENT_CHAT_LIMITS.maxMessageLength, {
      message: `Tin nhắn tối đa ${AGENT_CHAT_LIMITS.maxMessageLength} ký tự.`,
    })
    .refine((v) => !v.includes("\u0000"), { message: "Tin nhắn chứa ký tự không hợp lệ." }),
});

export type AgentChatMessage = z.infer<typeof agentChatMessageSchema>;

/** 1..20 messages, the last one from the user (the request being answered). */
export const agentChatHistorySchema = z
  .array(agentChatMessageSchema)
  .min(1, { message: "Thiếu tin nhắn." })
  .max(AGENT_CHAT_LIMITS.maxMessages, { message: "Cuộc trò chuyện quá dài, hãy bắt đầu lại." })
  .refine((messages) => messages.at(-1)?.role === "user", { message: "Tin nhắn cuối phải là của người dùng." });
