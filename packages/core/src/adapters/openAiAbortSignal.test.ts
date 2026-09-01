import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AlibabaJsonParseError,
  AlibabaJsonValidationError,
  AlibabaTextAdapter
} from "./alibaba.js";
import { DeepInfraAdapter } from "./deepinfra.js";
import {
  DeepSeekAdapter,
  DeepSeekJsonParseError,
  DeepSeekJsonValidationError
} from "./deepseek.js";
import { AdapterJsonParseError, AdapterJsonValidationError } from "./json.js";
import { OpenAICompatibleTextAdapter } from "./openaiCompatible.js";
import { OpenRouterAdapter } from "./openrouter.js";
import { OPENROUTER_GLM_53_FLASH_MODEL } from "./openrouterModels.js";
import type { ChatMessage, TextModelAdapter, Usage } from "./types.js";

type AdapterCase = {
  name: string;
  create: () => TextModelAdapter;
  provider: string;
  model: string;
  usagePayload: Record<string, unknown>;
  usage: Usage;
  reasoningParameters: Record<string, unknown>;
  absentReasoningParameters: string[];
  includeUsageInTextStream: boolean;
};

const adapterCases: AdapterCase[] = [
  {
    name: "AlibabaTextAdapter",
    create: () => new AlibabaTextAdapter({ apiKey: "test-key", textModel: "qwen-plus" }),
    provider: "alibaba",
    model: "qwen-plus",
    usagePayload: { prompt_tokens: 7, completion_tokens: 5, prompt_cache_hit_tokens: 2 },
    usage: { promptTokens: 7, outputTokens: 5 },
    reasoningParameters: {},
    absentReasoningParameters: ["thinking", "reasoning", "reasoning_effort"],
    includeUsageInTextStream: true
  },
  {
    name: "DeepInfraAdapter",
    create: () =>
      new DeepInfraAdapter({
        apiKey: "test-key",
        model: "test-deepinfra-model",
        thinkingEffort: "low"
      }),
    provider: "deepinfra",
    model: "test-deepinfra-model",
    usagePayload: {
      prompt_tokens: 7,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 2 }
    },
    usage: { promptTokens: 7, outputTokens: 5, cacheHitTokens: 2 },
    reasoningParameters: {
      reasoning: { enabled: true, effort: "low" },
      reasoning_effort: "low"
    },
    absentReasoningParameters: ["thinking"],
    includeUsageInTextStream: true
  },
  {
    name: "DeepSeekAdapter",
    create: () =>
      new DeepSeekAdapter({
        apiKey: "test-key",
        model: "test-deepseek-model",
        thinkingEffort: "max"
      }),
    provider: "deepseek",
    model: "test-deepseek-model",
    usagePayload: {
      prompt_tokens: 7,
      completion_tokens: 5,
      prompt_cache_hit_tokens: 2
    },
    usage: { promptTokens: 7, outputTokens: 5, cacheHitTokens: 2 },
    reasoningParameters: {
      thinking: { type: "enabled" },
      reasoning_effort: "max"
    },
    absentReasoningParameters: ["reasoning"],
    includeUsageInTextStream: true
  },
  {
    name: "OpenRouterAdapter",
    create: () =>
      new OpenRouterAdapter({
        apiKey: "test-key",
        model: OPENROUTER_GLM_53_FLASH_MODEL,
        thinkingEffort: "high"
      }),
    provider: "openrouter",
    model: OPENROUTER_GLM_53_FLASH_MODEL,
    usagePayload: {
      prompt_tokens: 7,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 2 }
    },
    usage: { promptTokens: 7, outputTokens: 5, cacheHitTokens: 2 },
    reasoningParameters: {
      reasoning: { enabled: true, effort: "high" },
      reasoning_effort: "high"
    },
    absentReasoningParameters: ["thinking"],
    includeUsageInTextStream: true
  },
  {
    name: "OpenAICompatibleTextAdapter",
    create: () =>
      new OpenAICompatibleTextAdapter({
        apiKey: "test-key",
        baseURL: "http://localhost:1234/v1",
        model: "test-local-model"
      }),
    provider: "openai-compatible",
    model: "test-local-model",
    usagePayload: { prompt_tokens: 7, completion_tokens: 5, prompt_cache_hit_tokens: 2 },
    usage: { promptTokens: 7, outputTokens: 5 },
    reasoningParameters: {},
    absentReasoningParameters: ["thinking", "reasoning", "reasoning_effort"],
    includeUsageInTextStream: false
  }
];

const toolMessages: ChatMessage[] = [
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_1", name: "lookup", arguments: { term: "moon" } }]
  },
  {
    role: "tool",
    content: JSON.stringify({ answer: 42 }),
    toolCallId: "call_1",
    toolName: "lookup"
  }
];

describe.each(adapterCases)("$name OpenAI chat-completions contract", (adapterCase) => {
  it("forwards abort signals through every request path", async () => {
    const adapter = adapterCase.create();
    const mock = installMockClient(adapter, adapterCase.usagePayload);
    const signal = new AbortController().signal;

    await exerciseEveryPath(adapter, { messages: [{ role: "user", content: "Draft a paragraph." }], signal });

    expect(mock.calls).toHaveLength(6);
    expect(mock.calls.map((call) => call.options)).toEqual(Array.from({ length: 6 }, () => ({ signal })));
  });

  it("converts assistant tool calls and tool results on every request path", async () => {
    const adapter = adapterCase.create();
    const mock = installMockClient(adapter, adapterCase.usagePayload);

    await exerciseEveryPath(adapter, { messages: toolMessages });

    expect(mock.calls).toHaveLength(6);
    for (const { request } of mock.calls) {
      expect(request.messages).toEqual(expect.arrayContaining([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: JSON.stringify({ term: "moon" }) }
            }
          ]
        },
        {
          role: "tool",
          content: JSON.stringify({ answer: 42 }),
          tool_call_id: "call_1"
        }
      ]));
      expect(JSON.stringify(request.messages)).not.toMatch(/toolCallId|toolName|toolCalls/);
    }
  });

  it("collects callback text and streamed JSON with usage and provider metadata", async () => {
    const adapter = adapterCase.create();
    const mock = installMockClient(adapter, adapterCase.usagePayload);
    const textChunks: string[] = [];
    const chunks: string[] = [];

    const textResult = await adapter.generateText({
      messages: [{ role: "user", content: "Return the value." }],
      onOutputTextChunk: (chunk) => {
        textChunks.push(chunk);
      }
    });
    const result = await adapter.generateJson({
      messages: [{ role: "user", content: "Return the value." }],
      schema: z.object({ value: z.string() }),
      onOutputTextChunk: (chunk) => {
        chunks.push(chunk);
      }
    });

    expect(textChunks).toEqual([`{"value":`, `"ok"}`]);
    expect(textResult).toEqual({
      text: `{"value":"ok"}`,
      model: adapterCase.model,
      provider: adapterCase.provider,
      usage: adapterCase.usage
    });
    expect(chunks).toEqual([`{"value":`, `"ok"}`]);
    expect(result).toEqual({
      data: { value: "ok" },
      text: `{"value":"ok"}`,
      model: adapterCase.model,
      provider: adapterCase.provider,
      usage: adapterCase.usage
    });
    expect(mock.calls[0]?.request).toMatchObject({
      model: adapterCase.model,
      stream: true,
      stream_options: { include_usage: true }
    });
    expect(mock.calls[1]?.request).toMatchObject({
      model: adapterCase.model,
      response_format: { type: "json_object" },
      stream: true,
      stream_options: { include_usage: true }
    });
  });

  it("maps usage and provider/model metadata for text and tool calls", async () => {
    const adapter = adapterCase.create();
    installMockClient(adapter, adapterCase.usagePayload);

    const textResult = await adapter.generateText({
      messages: [{ role: "user", content: "Draft a paragraph." }]
    });
    const toolResult = await adapter.generateWithTools({
      messages: [{ role: "user", content: "Look it up." }],
      tools: [lookupTool]
    });

    expect(textResult).toMatchObject({
      model: adapterCase.model,
      provider: adapterCase.provider,
      usage: adapterCase.usage
    });
    expect(toolResult).toEqual({
      text: "",
      model: adapterCase.model,
      provider: adapterCase.provider,
      usage: adapterCase.usage,
      toolCalls: [{ id: "call_response", name: "lookup", arguments: { term: "moon" } }]
    });
  });

  it("applies provider request and reasoning parameters on every path", async () => {
    const adapter = adapterCase.create();
    const mock = installMockClient(adapter, adapterCase.usagePayload);

    await exerciseEveryPath(adapter, {
      messages: [{ role: "user", content: "Draft a paragraph." }],
      temperature: 0.25,
      maxTokens: 321
    });

    expect(mock.calls).toHaveLength(6);
    for (const { request } of mock.calls) {
      expect(request).toMatchObject({
        model: adapterCase.model,
        temperature: 0.25,
        max_tokens: 321,
        ...adapterCase.reasoningParameters
      });
      for (const parameter of adapterCase.absentReasoningParameters) {
        expect(request).not.toHaveProperty(parameter);
      }
    }
    expect(mock.calls[1]?.request).toHaveProperty("stream_options.include_usage", true);
    expect(mock.calls[3]?.request).toHaveProperty("stream_options.include_usage", true);
    if (adapterCase.includeUsageInTextStream) {
      expect(mock.calls[4]?.request).toHaveProperty("stream_options.include_usage", true);
    } else {
      expect(mock.calls[4]?.request).not.toHaveProperty("stream_options");
    }
  });

  it("propagates streamed usage and identity on JSON validation errors", async () => {
    const adapter = adapterCase.create();
    installMockClient(adapter, adapterCase.usagePayload, [`{"value":`, `1}`]);

    await expect(adapter.generateJson({
      messages: [{ role: "user", content: "Return the value." }],
      purpose: "contract-validation",
      schema: z.object({ value: z.string() }),
      onOutputTextChunk: () => undefined
    })).rejects.toMatchObject({
      provider: adapterCase.provider,
      model: adapterCase.model,
      usage: adapterCase.usage
    });
  });
});

describe("provider JSON error export compatibility", () => {
  it("keeps the Alibaba and DeepSeek aliases bound to the shared error classes", () => {
    expect(AlibabaJsonParseError).toBe(AdapterJsonParseError);
    expect(AlibabaJsonValidationError).toBe(AdapterJsonValidationError);
    expect(DeepSeekJsonParseError).toBe(AdapterJsonParseError);
    expect(DeepSeekJsonValidationError).toBe(AdapterJsonValidationError);
  });
});

const lookupTool = {
  name: "lookup",
  description: "Look something up.",
  parameters: z.object({ term: z.string().optional() })
};

async function exerciseEveryPath(
  adapter: TextModelAdapter,
  options: {
    messages: ChatMessage[];
    signal?: AbortSignal;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<void> {
  const common = {
    messages: options.messages,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens })
  };
  await adapter.generateText(common);
  await adapter.generateText({ ...common, onOutputTextChunk: () => undefined });
  await adapter.generateJson({ ...common, schema: z.object({ value: z.string() }) });
  await adapter.generateJson({
    ...common,
    schema: z.object({ value: z.string() }),
    onOutputTextChunk: () => undefined
  });
  await consume(adapter.streamText(common));
  await adapter.generateWithTools({ ...common, tools: [lookupTool] });
}

async function consume(stream: AsyncGenerator<string>): Promise<void> {
  for await (const _chunk of stream) {
    // Exhaust the stream so the provider request and message conversion run.
  }
}

function installMockClient(
  adapter: TextModelAdapter,
  usage: Record<string, unknown>,
  streamParts = [`{"value":`, `"ok"}`]
): { calls: Array<{ request: Record<string, unknown>; options: unknown }> } {
  const calls: Array<{ request: Record<string, unknown>; options: unknown }> = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>, options: unknown) => {
          calls.push({ request, options });
          if (request.stream) {
            return (async function* () {
              for (const content of streamParts) {
                yield { choices: [{ delta: { content } }], usage: null };
              }
              yield { choices: [], usage };
            })();
          }
          if (request.tools) {
            return {
              choices: [{
                message: {
                  content: null,
                  tool_calls: [{
                    id: "call_response",
                    type: "function",
                    function: { name: "lookup", arguments: JSON.stringify({ term: "moon" }) }
                  }]
                }
              }],
              usage
            };
          }
          return {
            choices: [{ message: { content: `{"value":"ok"}` } }],
            usage
          };
        }
      }
    }
  };
  (adapter as unknown as { client: unknown }).client = client;
  return { calls };
}
