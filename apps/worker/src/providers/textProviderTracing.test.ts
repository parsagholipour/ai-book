import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AlibabaTextAdapter, DeepInfraAdapter, DeepSeekAdapter, FallbackTextModelAdapter, GeminiTextAdapter,
  OpenAITextAdapter, OpenRouterAdapter, ProviderHttpError, generateJsonWithRetry,
  type GenerateTextOptions, type TextModelAdapter
} from "@book-maker/core";
import { MemoryObjectStore, readRunLog, setObjectStoreForTests } from "@book-maker/storage";

vi.mock("@book-maker/db", () => ({ Prisma: {}, prisma: { providerCallLog: {
  create: vi.fn(async () => ({ id: "usage" })), update: vi.fn(async () => ({})), findUnique: vi.fn(async () => null)
} } }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: vi.fn(), updateJobProgress: vi.fn() }));

import { LoggingTextModelAdapter } from "./loggedAdapters.js";
import { createRunLogger } from "./runLogging.js";

const options = { messages: [{ role: "user" as const, content: "Write the chapter." }], purpose: "compose-chapter", maxTokens: 10_608 };
const schema = z.object({ value: z.string() });
type Provider = "openai" | "gemini" | "openrouter" | "alibaba" | "deepseek" | "deepinfra";
type Operation = "generateText" | "generateJson" | "generateWithTools" | "streamText";
type WireRequest = { stream?: boolean; max_output_tokens?: number; max_tokens?: number; config?: { maxOutputTokens?: number } };

function fixture(provider: Provider, outcomes: Array<"success" | "incomplete" | Error> = []) {
  const model = provider === "openai" ? "gpt-5.6-sol" : provider === "gemini" ? "gemini-3.7-flash" : "z-ai/glm-5";
  const adapter = provider === "openai" ? new OpenAITextAdapter({ apiKey: "test", model, thinkingEffort: "max" })
    : provider === "gemini" ? new GeminiTextAdapter({ apiKey: "test", textModel: model, thinkingEffort: "high" })
      : provider === "alibaba" ? new AlibabaTextAdapter({ apiKey: "test", textModel: model })
        : provider === "deepseek" ? new DeepSeekAdapter({ apiKey: "test", model })
          : provider === "deepinfra" ? new DeepInfraAdapter({ apiKey: "test", model })
            : new OpenRouterAdapter({ apiKey: "test", model });
  const requests: WireRequest[] = [];
  const text = '{"value":"ok"}';
  const create = async (request: WireRequest) => {
    requests.push(request);
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    const incomplete = outcome === "incomplete";
    if (provider === "gemini") return {
      text, candidates: [{ finishReason: incomplete ? "MAX_TOKENS" : "STOP" }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 12, thoughtsTokenCount: 100 }
    };
    const usage = { input_tokens: 20, output_tokens: 112, output_tokens_details: { reasoning_tokens: 100 },
      prompt_tokens: 20, completion_tokens: 112, completion_tokens_details: { reasoning_tokens: 100 } };
    const response = { model, output_text: text, status: incomplete ? "incomplete" : "completed",
      incomplete_details: { reason: "max_output_tokens" }, usage, choices: [{ message: { content: text } }] };
    if (!request.stream) return response;
    return (async function* () {
      if (provider === "openai") {
        yield { type: "response.output_text.delta", delta: text };
        yield { type: incomplete ? "response.incomplete" : "response.completed", response };
      } else {
        yield { choices: [{ delta: { content: text } }], usage };
      }
    })();
  };
  if (provider === "gemini") Object.assign(adapter, { ai: { models: {
    generateContent: create, generateContentStream: async function* (request: WireRequest) { yield await create(request); }
  } } });
  else Object.assign(adapter, { client: { responses: { create }, chat: { completions: { create } } } });
  const effective = provider === "openai" ? 48_000 : provider === "gemini" ? 32_000 : options.maxTokens;
  return { adapter, requests, model, effective };
}

function logged(adapter: TextModelAdapter) {
  const logger = createRunLogger({ id: "bull", name: "generate-book", data: { projectId: "p", generationJobId: "run" } } as Parameters<typeof createRunLogger>[0]);
  return {
    adapter: new LoggingTextModelAdapter(adapter, logger, undefined, "p", { provider: "openai", model: "routed-model" }),
    entries: async () => (await readRunLog(logger.filePath)).trim().split("\n").map((line) => JSON.parse(line))
  };
}

async function invoke(adapter: TextModelAdapter, operation: Operation, callOptions: GenerateTextOptions = options) {
  if (operation === "generateJson") return adapter.generateJson({ ...callOptions, schema });
  if (operation === "generateWithTools") return adapter.generateWithTools({ ...callOptions, tools: [] });
  if (operation === "streamText") { for await (const _chunk of adapter.streamText(callOptions)) { /* Drain the public stream. */ } return; }
  return adapter.generateText(callOptions);
}

beforeEach(() => { setObjectStoreForTests(new MemoryObjectStore()); });
afterEach(() => { setObjectStoreForTests(null); vi.restoreAllMocks(); });

describe.each<Provider>(["openai", "gemini", "openrouter", "alibaba", "deepseek", "deepinfra"])("durable %s provider context", (provider) => {
  it.each<Operation>(["generateText", "generateJson", "generateWithTools", "streamText"])("records the wire allowance and reasoning usage for %s", async (operation) => {
    const inner = fixture(provider);
    const run = logged(inner.adapter);
    await invoke(run.adapter, operation);
    const entries = await run.entries();
    const request = entries.find((entry) => entry.event === `text.${operation}.provider_request`);
    const usage = entries.find((entry) => entry.event === `text.${operation}.provider_usage`);
    const response = entries.find((entry) => entry.event === `text.${operation}.response`);
    const context = { provider, model: inner.model, requestedMaxTokens: 10_608, effectiveMaxTokens: inner.effective, requestIndex: 1 };
    expect(request).toMatchObject(context);
    expect(usage).toMatchObject({ callId: request.callId, providerRequest: context, usage: { reasoningTokens: 100, outputTokens: 112 } });
    expect(response).toMatchObject({ callId: request.callId, providerRequest: context });
    expect(inner.requests).toHaveLength(1);
    const wire = inner.requests[0]!;
    expect(wire.max_output_tokens ?? wire.config?.maxOutputTokens ?? wire.max_tokens).toBe(request.effectiveMaxTokens);
  });

  it.each(["generateText", "generateJson"] as const)("reports non-streaming %s dispatches too", async (operation) => {
    const inner = fixture(provider);
    const onProviderRequest = vi.fn();
    const onProviderUsage = vi.fn();
    await invoke(inner.adapter, operation, { ...options, onProviderRequest, onProviderUsage });
    expect(onProviderRequest).toHaveBeenCalledExactlyOnceWith({ provider, model: inner.model, requestedMaxTokens: 10_608, effectiveMaxTokens: inner.effective });
    expect(onProviderUsage).toHaveBeenCalledWith(expect.objectContaining({ reasoningTokens: 100 }));
    expect(inner.requests[0]?.stream).not.toBe(true);
  });
});

it.each<Provider>(["openai", "gemini"])("keeps paid usage and both allowances when %s truncates", async (provider) => {
  const inner = fixture(provider, ["incomplete"]);
  const run = logged(inner.adapter);
  await expect(run.adapter.generateJson({ ...options, schema })).rejects.toThrow(/incomplete/);
  const failure = (await run.entries()).find((entry) => entry.event === "text.generateJson.error");
  expect(failure).toMatchObject({ providerRequest: { requestedMaxTokens: 10_608, effectiveMaxTokens: inner.effective },
    error: { usage: { reasoningTokens: 100, outputTokens: 112 } } });
});

it("records each widened retry's requested and effective limit", async () => {
  const run = logged(fixture("openai", ["incomplete", "success"]).adapter);
  await generateJsonWithRetry(run.adapter, { ...options, schema });
  const requests = (await run.entries()).filter((entry) => entry.event === "text.generateJson.provider_request");
  expect(requests.map(({ requestedMaxTokens, effectiveMaxTokens }) => [requestedMaxTokens, effectiveMaxTokens])).toEqual([
    [10_608, 48_000], [72_000, 72_000]
  ]);
});

it("increments the request index on a recoverable network retry", async () => {
  const run = logged(fixture("openai", [new ProviderHttpError("Rate limited", { status: 429, retryAfterMs: 1 }), "success"]).adapter);
  await run.adapter.generateText(options);
  const requests = (await run.entries()).filter((entry) => entry.event === "text.generateText.provider_request");
  expect(requests.map((entry) => entry.requestIndex)).toEqual([1, 2]);
  expect(new Set(requests.map((entry) => entry.callId)).size).toBe(1);
  expect(requests.every((entry) => entry.effectiveMaxTokens === 48_000)).toBe(true);
});

it("keeps concurrent calls' allowances separate on the same adapter", async () => {
  const run = logged(fixture("openai").adapter);
  await Promise.all([50_000, 60_000].map((maxTokens) => run.adapter.generateText({ ...options, maxTokens })));
  const entries = await run.entries();
  const responses = entries.filter((entry) => entry.event === "text.generateText.response");
  expect(new Set(responses.map((entry) => entry.callId)).size).toBe(2);
  for (const response of responses) {
    const request = entries.find((entry) => entry.event === "text.generateText.request" && entry.callId === response.callId);
    expect(response.providerRequest).toMatchObject({ requestIndex: 1,
      requestedMaxTokens: request.request.maxTokens, effectiveMaxTokens: request.request.maxTokens });
  }
});

it("keeps separate provider requests and usage when the primary falls back", async () => {
  const primary = fixture("openai", ["incomplete"]);
  const fallback = fixture("gemini");
  const run = logged(new FallbackTextModelAdapter({
    primary: { selection: { provider: "openai", model: primary.model }, adapter: primary.adapter },
    fallback: { selection: { provider: "gemini", model: fallback.model }, adapter: fallback.adapter },
    shouldFallback: () => true
  }));
  await run.adapter.generateText(options);
  const entries = await run.entries();
  const usage = entries.filter((entry) => entry.event === "text.generateText.provider_usage");
  expect(usage.map((entry) => [entry.providerRequest.provider, entry.providerRequest.requestIndex, entry.providerRequest.effectiveMaxTokens])).toEqual([
    ["openai", 1, 48_000], ["gemini", 2, 32_000]
  ]);
  expect(new Set(usage.map((entry) => entry.callId)).size).toBe(1);
  expect(entries.find((entry) => entry.event === "text.generateText.response").providerRequest.provider).toBe("gemini");
});

it("writes dispatch context even when no response arrives", async () => {
  const run = logged(fixture("openai", [new Error("permission denied")]).adapter);
  await expect(run.adapter.generateText(options)).rejects.toThrow("permission denied");
  const entries = await run.entries();
  expect(entries.find((entry) => entry.event === "text.generateText.error").providerRequest).toMatchObject({ effectiveMaxTokens: 48_000 });
  expect(entries.some((entry) => entry.event.endsWith("provider_usage"))).toBe(false);
});

it.each([undefined, 60_000])("preserves an unspecified or larger explicit limit (%s)", async (maxTokens) => {
  const run = logged(fixture("openai").adapter);
  await run.adapter.generateText({ messages: options.messages, purpose: options.purpose, ...(maxTokens === undefined ? {} : { maxTokens }) });
  expect((await run.entries()).find((entry) => entry.event.endsWith("provider_request"))).toMatchObject({
    requestedMaxTokens: maxTokens ?? null, effectiveMaxTokens: maxTokens ?? null
  });
});

it("does not fail or repeat a paid call when observers throw", async () => {
  const inner = fixture("openai");
  const run = logged(inner.adapter);
  const fail = async () => { throw new Error("observer unavailable"); };
  await expect(run.adapter.generateText({ ...options, onProviderRequest: fail, onProviderUsage: fail })).resolves.toMatchObject({ provider: "openai" });
  expect(inner.requests).toHaveLength(1);
  expect((await run.entries()).some((entry) => entry.event.endsWith("provider_usage"))).toBe(true);
});
