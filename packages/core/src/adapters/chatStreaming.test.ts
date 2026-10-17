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

  it("replaces the preview on a retry, never joining two answers or blanking the first", async () => {
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
    expect(previews).toEqual(["", "Abandoned", "Correct"]);
    expect(result.finish).toEqual({ assistantMessage: "Correct" });
  });

  // One scripted model call: the tool calls it streams, then what it returns.
  type ScriptedCall = { calls: Array<{ name: string; arguments: Record<string, unknown> }> };
  function scriptedModel(script: ScriptedCall[]) {
    const adapter = new DeepSeekAdapter({ apiKey: "test" });
    let call = 0;
    Object.assign(adapter, { generateWithTools: async (options: GenerateWithToolsOptions): Promise<ToolCallsResult> => {
      const { calls } = script[call++]!;
      await options.onToolCallProgress?.({ type: "start" });
      for (const [index, tool] of calls.entries()) {
        const json = JSON.stringify(tool.arguments);
        // Stream each call's arguments in a few slices, as a provider does.
        for (const end of [Math.ceil(json.length / 3), Math.ceil((2 * json.length) / 3), json.length]) {
          await options.onToolCallProgress?.({ type: "arguments", index, name: tool.name, argumentsText: json.slice(0, end) });
        }
      }
      return { text: "", model: "test", provider: "test", toolCalls: calls.map((tool, index) => ({ id: `c${index}`, ...tool })) };
    } });
    return adapter;
  }
  const strictFinish = { ...finishTool, parameters: z.object({ assistantMessage: z.string(), done: z.literal(true) }) };

  it("does not redraw a reply a second call sends again, and never blanks it in between", async () => {
    const previews: string[] = [];
    const reply = "Here is a calm story about a lighthouse keeper and the gulls she feeds.";
    // The first finish fails its schema, so the loop asks again and the model resends the same reply.
    const result = await runToolLoop({ textModel: scriptedModel([
      { calls: [{ name: "finish_turn", arguments: { assistantMessage: reply } }] },
      { calls: [{ name: "finish_turn", arguments: { assistantMessage: reply, done: true } }] }
    ]), messages: [], tools: [], finishTool: strictFinish, onAssistantText: (text) => { previews.push(text); } });
    expect(result.finish).toEqual({ assistantMessage: reply, done: true });
    expect(previews[0]).toBe("");
    expect(previews.at(-1)).toBe(reply);
    expect(previews.slice(1)).not.toContain("");
    // Everything after the first full reply is nothing: the second call drew no frame.
    expect(previews.slice(previews.indexOf(reply) + 1)).toEqual([]);
  });

  it("lets a second call that says something else take over the preview without blanking it", async () => {
    const previews: string[] = [];
    await runToolLoop({ textModel: scriptedModel([
      { calls: [{ name: "finish_turn", arguments: { assistantMessage: "A mystery set in Lisbon." } }] },
      { calls: [{ name: "finish_turn", arguments: { assistantMessage: "A mystery set in Porto, then.", done: true } }] }
    ]), messages: [], tools: [], finishTool: strictFinish, onAssistantText: (text) => { previews.push(text); } });
    expect(previews.slice(1)).not.toContain("");
    expect(previews.at(-1)).toBe("A mystery set in Porto, then.");
  });

  it("does not preview a finish called beside a tool whose result it has not seen", async () => {
    const previews: string[] = [];
    const search = { name: "web_search", description: "Search", parameters: z.object({ query: z.string() }), execute: () => ({ found: "Porto" }) };
    const result = await runToolLoop({ textModel: scriptedModel([
      { calls: [
        { name: "web_search", arguments: { query: "harbour towns" } },
        { name: "finish_turn", arguments: { assistantMessage: "Before searching, I think Lisbon." } }
      ] },
      { calls: [{ name: "finish_turn", arguments: { assistantMessage: "Porto it is." } }] }
    ]), messages: [], tools: [search], finishTool, onAssistantText: (text) => { previews.push(text); } });
    expect(result.finish).toEqual({ assistantMessage: "Porto it is." });
    expect(previews.some((text) => text.includes("Lisbon"))).toBe(false);
    expect(previews.at(-1)).toBe("Porto it is.");
  });

  it("previews a finish beside a pure tool, because that finish is the answer", async () => {
    const previews: string[] = [];
    const settings = { name: "update_settings", description: "Settings", parameters: z.object({ pages: z.number() }), pure: true, execute: () => ({ applied: true }) };
    await runToolLoop({ textModel: scriptedModel([
      { calls: [
        { name: "update_settings", arguments: { pages: 12 } },
        { name: "finish_turn", arguments: { assistantMessage: "Twelve pages it is." } }
      ] }
    ]), messages: [], tools: [settings], finishTool, onAssistantText: (text) => { previews.push(text); } });
    expect(previews.at(-1)).toBe("Twelve pages it is.");
  });
});
