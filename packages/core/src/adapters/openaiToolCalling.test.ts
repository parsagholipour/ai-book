import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toOpenAiChatMessages, toOpenAiTools, toolCallsFromOpenAiMessage } from "./openaiToolCalling.js";
import type { ChatMessage } from "./types.js";

describe("toOpenAiChatMessages", () => {
  it("maps assistant tool calls and tool results to the OpenAI wire format", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be helpful" },
      { role: "user", content: "search this" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "web_search", arguments: { query: "topic" } }]
      },
      { role: "tool", content: "{\"result\":\"found\"}", toolCallId: "call_1", toolName: "web_search" }
    ];

    const mapped = toOpenAiChatMessages(messages);

    expect(mapped[0]).toEqual({ role: "system", content: "be helpful" });
    expect(mapped[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "web_search", arguments: "{\"query\":\"topic\"}" } }
      ]
    });
    expect(mapped[3]).toEqual({ role: "tool", content: "{\"result\":\"found\"}", tool_call_id: "call_1" });
  });

  it("keeps plain assistant messages untouched", () => {
    const mapped = toOpenAiChatMessages([{ role: "assistant", content: "hi" }]);
    expect(mapped[0]).toEqual({ role: "assistant", content: "hi" });
  });
});

describe("toOpenAiTools", () => {
  it("serializes zod parameters to JSON Schema function declarations", () => {
    const [tool] = toOpenAiTools([
      {
        name: "web_search",
        description: "Search the web.",
        parameters: z.object({ query: z.string().min(2) })
      }
    ]);

    expect(tool).toMatchObject({
      type: "function",
      function: { name: "web_search", description: "Search the web." }
    });
    const parameters = (tool as { function: { parameters: Record<string, unknown> } }).function.parameters;
    expect(parameters.type).toBe("object");
    expect((parameters.properties as Record<string, unknown>).query).toBeDefined();
  });
});

describe("toolCallsFromOpenAiMessage", () => {
  it("parses tool call arguments from JSON strings", () => {
    const calls = toolCallsFromOpenAiMessage({
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "web_search", arguments: "{\"query\":\"x\"}" } }
      ]
    });

    expect(calls).toEqual([{ id: "call_1", name: "web_search", arguments: { query: "x" } }]);
  });

  it("preserves unparseable arguments under a marker key instead of crashing", () => {
    const calls = toolCallsFromOpenAiMessage({
      tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{broken" } }]
    });

    expect(calls[0]!.arguments).toEqual({ __unparsedArguments: "{broken" });
  });

  it("returns empty for messages without tool calls and fills missing ids", () => {
    expect(toolCallsFromOpenAiMessage({ content: "hi" })).toEqual([]);
    expect(toolCallsFromOpenAiMessage(undefined)).toEqual([]);
    const calls = toolCallsFromOpenAiMessage({
      tool_calls: [{ type: "function", function: { name: "a", arguments: "" } }]
    });
    expect(calls[0]!.id).toBe("call_0");
    expect(calls[0]!.arguments).toEqual({});
  });
});
