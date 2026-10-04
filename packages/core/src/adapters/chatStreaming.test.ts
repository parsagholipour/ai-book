import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DeepSeekAdapter } from "./deepseek.js";
import { OpenAITextAdapter } from "./openai.js";
import { runToolLoop } from "./toolLoop.js";
import { partialJsonString } from "./streamedToolReply.js";
import { ProviderStreamInterruptedError } from "./retry.js";
import type { GenerateWithToolsOptions, ToolCallsResult } from "./types.js";

const finishTool = { name: "finish_turn", description: "Reply", parameters: z.object({ assistantMessage: z.string() }) };

describe("chat streaming", () => {
  it("extracts only a top-level reply and holds split JSON escapes until complete", () => {
    expect(partialJsonString('{"settings":{"assistantMessage":"private"},"assistantMessage":"Hello\\nwo', 'assistantMessage')).toBe('Hello\nwo');
    expect(partialJsonString('{"assistantMessage":"Hi\\uD83D', 'assistantMessage')).toBe('Hi');
    expect(partialJsonString('{"assistantMessage":"Hi\\uD83D\\uDE00', 'assistantMessage')).toBe('Hi😀');
    expect(partialJsonString('{"assistantMessage":"A\\', 'assistantMessage')).toBe('A');
    expect(partialJsonString('{"nested":{"assistantMessage":"private"}}', 'assistantMessage')).toBeUndefined();
  });

  it("streams tool arguments through the real tool loop before the provider finishes, preserving usage", async () => {
    const adapter = new DeepSeekAdapter({ apiKey: "test" });
    const previews: string[] = [];
    const request: Record<string, unknown>[] = [];
    Object.assign(adapter, { client: { chat: { completions: { create: async (body: Record<string, unknown>) => {
      request.push(body);
      return (async function* () {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "f", function: { name: "finish_turn", arguments: '{"assistantMessage":"Hel' } }] } }] };
        expect(previews.at(-1)).toBe("Hel");
        yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'lo"}' } }] }, finish_reason: "tool_calls" }] };
        yield { choices: [], usage: { prompt_tokens: 4, completion_tokens: 5 } };
      })();
    } } } } });
    const result = await runToolLoop({ textModel: adapter, messages: [], tools: [], finishTool, onAssistantText: (text) => { previews.push(text); } });
    expect(request[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(result.finish).toEqual({ assistantMessage: "Hello" });
    expect(result.usage).toMatchObject({ promptTokens: 4, outputTokens: 5 });
    expect(previews).toContain("Hello");
  });

  it("streams Responses tool arguments and keeps the terminal structured output", async () => {
    const adapter = new OpenAITextAdapter({ apiKey: "test" });
    const previews: string[] = [];
    Object.assign(adapter, { client: { responses: { create: async () => (async function* () {
      yield { type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "finish_turn", arguments: "" } };
      yield { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"assistantMessage":"Hi' };
      expect(previews.at(-1)).toBe("Hi");
      yield { type: "response.function_call_arguments.delta", output_index: 0, delta: '!"}' };
      yield { type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "f", name: "finish_turn", arguments: '{"assistantMessage":"Hi!"}' }], usage: { input_tokens: 4, output_tokens: 5 } } };
    })() } } });
    const result = await runToolLoop({ textModel: adapter, messages: [], tools: [], finishTool, onAssistantText: (text) => { previews.push(text); } });
    expect(result.finish).toEqual({ assistantMessage: "Hi!" });
    expect(result.usage).toMatchObject({ promptTokens: 4, outputTokens: 5 });
  });

  it("does not accept a truncated tool stream as a complete reply", async () => {
    const adapter = new DeepSeekAdapter({ apiKey: "test" });
    Object.assign(adapter, { client: { chat: { completions: { create: async () => (async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "f", function: { name: "finish_turn", arguments: '{"assistantMessage":"partial' } }] } }] };
    })() } } } });
    await expect(adapter.generateWithTools({ messages: [], tools: [finishTool], onToolCallProgress: () => {} })).rejects.toBeInstanceOf(ProviderStreamInterruptedError);
  });

  it.each(["eof", "socket error"])("rejects an interrupted plain-text reply with its reported usage (%s)", async (ending) => {
    const adapter = new DeepSeekAdapter({ apiKey: "test" });
    const previews: string[] = [];
    Object.assign(adapter, { client: { chat: { completions: { create: async () => (async function* () {
      yield { choices: [{ delta: { content: "The answer is" } }], usage: { prompt_tokens: 4, completion_tokens: 5 } };
      if (ending === "socket error") throw new Error("Connection closed");
    })() } } } });
    const error = await adapter.generateText({ messages: [], onOutputTextChunk: (text) => { previews.push(text); } }).catch((caught: unknown) => caught);
    expect(previews).toEqual(["The answer is"]);
    expect(error).toMatchObject({ provider: "deepseek", usage: { promptTokens: 4, outputTokens: 5 } });
    if (ending === "eof") expect(error).toBeInstanceOf(ProviderStreamInterruptedError);
    else expect(error).toMatchObject({ message: "Connection closed" });
  });

  it.each(["stop", "length"])("retains a completed text response and usage after its terminal chunk (%s)", async (finishReason) => {
    const adapter = new DeepSeekAdapter({ apiKey: "test" });
    Object.assign(adapter, { client: { chat: { completions: { create: async () => (async function* () {
      yield { choices: [{ delta: { content: "The answer." } }] };
      yield { choices: [{ delta: {}, finish_reason: finishReason }] };
      yield { choices: [], usage: { prompt_tokens: 4, completion_tokens: 5 } };
    })() } } } });
    await expect(adapter.generateText({ messages: [], onOutputTextChunk: () => {} })).resolves.toMatchObject({
      text: "The answer.", usage: { promptTokens: 4, outputTokens: 5 }
    });
  });

  it.each(["success", "timeout"])("ignores late tool and plain-text callbacks after a model call ends (%s)", async (settlement) => {
    const adapter = new DeepSeekAdapter({ apiKey: "test" });
    const previews: string[] = [];
    let request!: GenerateWithToolsOptions;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const result: ToolCallsResult = { text: "Saved", model: "test", provider: "test", toolCalls: [] };
    Object.assign(adapter, { generateWithTools: async (options: GenerateWithToolsOptions) => {
      request = options;
      await options.onToolCallProgress?.({ type: "start" });
      await options.onOutputTextChunk?.("Preview");
      if (settlement === "timeout") await pending;
      return result;
    } });
    const loop = runToolLoop({ textModel: adapter, messages: [], tools: [],
      onAssistantText: (text) => { previews.push(text); },
      onModelCall: async (invoke) => {
        const work = invoke();
        if (settlement === "success") return work;
        // As with a timeout wrapper, the caller settles while the provider continues.
        await Promise.resolve();
        throw new Error("Call budget exceeded");
      }
    });
    if (settlement === "success") await expect(loop).resolves.toMatchObject({ finalText: "Saved" });
    else await expect(loop).rejects.toThrow("Call budget exceeded");
    const acceptedPreviews = [...previews];
    await request.onOutputTextChunk?.(" stale continuation");
    await request.onToolCallProgress?.({ type: "arguments", index: 0, name: "finish_evidence_answer", argumentsText: '{"answer":"Late answer"}' });
    release();
    expect(previews).toEqual(acceptedPreviews);
  });

  it("resets the preview before a retry instead of joining two answers", async () => {
    const adapter = new DeepSeekAdapter({ apiKey: "test" });
    const previews: string[] = [];
    let attempt = 0;
    Object.assign(adapter, { client: { chat: { completions: { create: async () => (async function* () {
      attempt++;
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "f", function: { name: "finish_turn", arguments: `{"assistantMessage":"${attempt === 1 ? "Abandoned" : "Correct"}` } }] } }] };
      if (attempt === 1) throw new Error("Connection closed");
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: "tool_calls" }] };
    })() } } } });
    const result = await runToolLoop({ textModel: adapter, messages: [], tools: [], finishTool,
      onAssistantText: (text) => { previews.push(text); },
      onModelCall: async (invoke) => { try { return await invoke(); } catch { return invoke(); } }
    });
    expect(previews.slice(previews.indexOf("Abandoned") + 1)).toContain("");
    expect(previews.at(-1)).toBe("Correct");
    expect(result.finish).toEqual({ assistantMessage: "Correct" });
  });
});
