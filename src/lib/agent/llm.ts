import "server-only";

import type OpenAI from "openai";
import type {
  FunctionTool,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseOutputItem,
} from "openai/resources/responses/responses";

import { createOpenAIClient, getOpenAIConfig, type OpenAIConfig } from "./config";
import { AGENT_LIMITS } from "./limits";

/**
 * The model behind the agent, behind a small interface so the agent loop does
 * not depend on the OpenAI SDK (and unit tests can use a scripted fake model).
 */

/** Input items the agent loop builds. "passthrough" items are model output sent back as-is. */
export type AgentInputItem =
  | { type: "message"; role: "user" | "assistant"; content: string }
  | { type: "function_call_output"; callId: string; output: string }
  | { type: "passthrough"; item: unknown };

export type AgentToolCall = { callId: string; name: string; arguments: string };

export type AgentModelResponse = {
  /** Assistant text of this round trip (may be empty when it only calls tools). */
  text: string;
  toolCalls: AgentToolCall[];
  /** Raw output items, to send back on the next round trip (keeps tool calls and reasoning paired). */
  outputItems: unknown[];
};

export type AgentModelRequest = {
  instructions: string;
  input: AgentInputItem[];
  tools: FunctionTool[];
  signal?: AbortSignal;
};

export interface AgentModel {
  respond(request: AgentModelRequest): Promise<AgentModelResponse>;
}

// ---------------------------------------------------------------------------
// OpenAI Responses API adapter
// ---------------------------------------------------------------------------

function toOpenAIInput(items: AgentInputItem[]): ResponseInputItem[] {
  return items.map((item): ResponseInputItem => {
    switch (item.type) {
      case "message":
        return { type: "message", role: item.role, content: item.content };
      case "function_call_output":
        return { type: "function_call_output", call_id: item.callId, output: item.output };
      case "passthrough":
        return item.item as ResponseInputItem;
    }
  });
}

/** Extracts text and function calls from the model output. */
export function parseOpenAIOutput(output: ResponseOutputItem[]): Omit<AgentModelResponse, "outputItems"> {
  const texts: string[] = [];
  const toolCalls: AgentToolCall[] = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") texts.push(part.text);
        else if (part.type === "refusal") texts.push(part.refusal);
      }
    } else if (item.type === "function_call") {
      toolCalls.push({ callId: item.call_id, name: item.name, arguments: item.arguments });
    }
  }
  return { text: texts.join("\n").trim(), toolCalls };
}

type ResponsesClient = Pick<OpenAI, "responses">;

/**
 * Stateless use of the Responses API: store=false (OpenAI keeps no conversation
 * state for us), one tool call at a time, bounded output. Each round trip sends
 * the whole turn, including the previous output items (and encrypted reasoning
 * for reasoning models).
 */
export function createOpenAIModel(
  config: OpenAIConfig = getOpenAIConfig(),
  client: ResponsesClient = createOpenAIClient(config),
): AgentModel {
  return {
    async respond({ instructions, input, tools, signal }) {
      const body: ResponseCreateParamsNonStreaming = {
        model: config.model,
        instructions,
        input: toOpenAIInput(input),
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: AGENT_LIMITS.maxOutputTokens,
      };
      const response = await client.responses.create(body, { signal });
      return { ...parseOpenAIOutput(response.output), outputItems: response.output };
    },
  };
}
