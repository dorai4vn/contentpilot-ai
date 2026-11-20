import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AGENT_LIMITS } from "./limits";
import { createOpenAIModel, parseOpenAIOutput } from "./llm";
import { openAIFunctionTools } from "./tools";

// Test-only dummy values; no real credentials and no network access.
const config = { apiKey: "sk-test-0000000000000000000000000000", model: "test-model-mini" };

function fakeClient(output: unknown[]) {
  const create = vi.fn().mockResolvedValue({ output });
  return { client: { responses: { create } } as never, create };
}

describe("parseOpenAIOutput", () => {
  it("collects text and function calls", () => {
    const parsed = parseOpenAIOutput([
      { type: "reasoning", id: "r1", summary: [] },
      {
        type: "message",
        id: "m1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Xin chào", annotations: [] },
          { type: "refusal", refusal: "Không thể" },
        ],
      },
      { type: "function_call", call_id: "c1", name: "get_post", arguments: '{"post_id":"x"}' },
    ] as never);
    expect(parsed).toEqual({
      text: "Xin chào\nKhông thể",
      toolCalls: [{ callId: "c1", name: "get_post", arguments: '{"post_id":"x"}' }],
    });
  });
});

describe("createOpenAIModel", () => {
  it("sends a stateless, single-tool-call, bounded request with strict tools", async () => {
    const { client, create } = fakeClient([]);
    const model = createOpenAIModel(config, client);
    const controller = new AbortController();
    await model.respond({
      instructions: "SYSTEM",
      input: [
        { type: "message", role: "user", content: "Liệt kê dự án" },
        { type: "passthrough", item: { type: "function_call", call_id: "c1", name: "list_projects", arguments: "{}" } },
        { type: "function_call_output", callId: "c1", output: '{"ok":true}' },
      ],
      tools: openAIFunctionTools(),
      signal: controller.signal,
    });

    const [body, requestOptions] = create.mock.calls[0]!;
    expect(body).toMatchObject({
      model: "test-model-mini",
      instructions: "SYSTEM",
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      max_output_tokens: AGENT_LIMITS.maxOutputTokens,
    });
    expect(body.input).toEqual([
      { type: "message", role: "user", content: "Liệt kê dự án" },
      { type: "function_call", call_id: "c1", name: "list_projects", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: '{"ok":true}' },
    ]);
    expect(body.tools.every((t: { strict: boolean }) => t.strict)).toBe(true);
    expect(requestOptions.signal).toBe(controller.signal);
    expect(JSON.stringify(body)).not.toContain(config.apiKey);
  });

  it("returns parsed calls and the raw items to send back", async () => {
    const output = [{ type: "function_call", call_id: "c9", name: "list_projects", arguments: "{}" }];
    const { client } = fakeClient(output);
    const result = await createOpenAIModel(config, client).respond({ instructions: "S", input: [], tools: [] });
    expect(result).toEqual({
      text: "",
      toolCalls: [{ callId: "c9", name: "list_projects", arguments: "{}" }],
      outputItems: output,
    });
  });

  it("propagates SDK errors to the agent loop (which hides them)", async () => {
    const create = vi.fn().mockRejectedValue(new Error("upstream failure"));
    const model = createOpenAIModel(config, { responses: { create } } as never);
    await expect(model.respond({ instructions: "S", input: [], tools: [] })).rejects.toThrow("upstream failure");
  });
});
