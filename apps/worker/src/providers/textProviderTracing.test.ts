import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AlibabaTextAdapter, DeepInfraAdapter, DeepSeekAdapter, FallbackTextModelAdapter, GeminiResearchAdapter, GeminiTextAdapter,
  OpenAITextAdapter, OpenRouterAdapter, ProviderHttpError, generateJsonWithRetry,
  composeChapter, createProjectSchema, makeFallbackPlan,
  type GenerateTextOptions, type TextModelAdapter
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { MemoryObjectStore, readRunLog, setObjectStoreForTests } from "@book-maker/storage";

vi.mock("@book-maker/db", () => ({ Prisma: {}, prisma: { providerCallLog: {
  create: vi.fn(async () => ({ id: "usage" })), update: vi.fn(async () => ({})), findUnique: vi.fn(async () => null)
} } }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: vi.fn(), updateJobProgress: vi.fn() }));

import { LoggingResearchAdapter, LoggingTextModelAdapter } from "./loggedAdapters.js";
import { createRunLogger } from "./runLogging.js";
import capturedProse from "../../../../packages/core/src/generation/testing/bolsonaroProseRunaway.json" with { type: "json" };

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
        yield { choices: [{ delta: {}, finish_reason: incomplete ? "length" : "stop" }] };
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

it("records a stopped prose loop as unknown usage and its fresh recovery as a separate paid call", async () => {
  vi.clearAllMocks();
  const adapter = new OpenAITextAdapter({ apiKey: "fixture", model: "gpt-6-luna", thinkingEffort: "none" });
  const good = Array.from({ length: 300 }, (_, i) => `Example ${i} distinguishes a specific policy decision from its measured public outcome.`).join(" ");
  let calls = 0;
  const closed: number[] = [];
  Object.assign(adapter, { client: { responses: { create: async () => {
    const call = ++calls;
    return (async function* () {
      try {
        yield { type: "response.output_text.delta", delta: call === 1 ? capturedProse.partialOutput.tail : good };
        yield { type: "response.completed", response: { status: "completed", model: "gpt-6-luna",
          usage: { input_tokens: 100, output_tokens: 4000 } } };
      } finally { closed.push(call); }
    })();
  } } } });
  const run = logged(adapter);
  const input = createProjectSchema.parse({ prompt: "Assess Bolsonaro's presidency", category: "BUSINESS", targetPages: 120 });
  const plan = makeFallbackPlan(input);
  const result = await composeChapter({ input, plan, chapter: plan.chapters[0]!, textModel: run.adapter,
    stance: { thesis: "Assess the record", positions: [], refusals: [], voiceSample: "Be specific." },
    composition: { chapterIndex: 1, throughLine: "Assess the record", sections: [{ form: "principle", subject: "Policy outcomes", share: 1, owns: [] }], landing: "A verdict", avoid: [] },
    chapterPageStart: 1, chapterPageEnd: 6, earlierChapters: [], continuityNotes: [], researchNotes: [] });
  expect(result.markdown).toBe(good);
  const entries = await run.entries();
  const requests = entries.filter(entry => entry.event === "text.generateText.provider_request");
  expect(requests.map(entry => [entry.attempt, entry.effectiveMaxTokens])).toEqual([[1, 12912], [2, 12912]]);
  expect(new Set(requests.map(entry => entry.callId)).size).toBe(2);
  expect(entries.find(entry => entry.event === "text.generateText.error")).toMatchObject({
    error: { name: "ProseOutputRepetitionError", context: { reason: "repeated_prose" } }
  });
  expect(prisma.providerCallLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    costHint: null, metadata: expect.objectContaining({ liveStatus: "failed", costStatus: "unknown_usage" })
  }) }));
  expect(prisma.providerCallLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    promptTokens: 100, outputTokens: 4000, metadata: expect.objectContaining({ liveStatus: "settled", provisional: false })
  }) }));
  expect(closed).toEqual([1, 2]);
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

function expectSettledTextUsage() {
  expect(prisma.providerCallLog.update).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      promptTokens: 20,
      outputTokens: 112,
      metadata: expect.objectContaining({ provisional: false, reasoningTokens: 100, liveStatus: "settled" })
    })
  }));
}

it.each<Provider>(["openai", "gemini"])("ledger settles paid %s text truncation", async (provider) => {
  vi.clearAllMocks();
  const run = logged(fixture(provider, ["incomplete"]).adapter);
  await expect(run.adapter.generateText(options)).rejects.toThrow(/incomplete/);
  expectSettledTextUsage();
});

it.each<Provider>(["openai", "gemini"])("ledger settles reported %s raw stream usage", async (provider) => {
  vi.clearAllMocks();
  await invoke(logged(fixture(provider).adapter).adapter, "streamText");
  expectSettledTextUsage();
});

function researchFixture(reportedUsage = true) {
  const adapter = new GeminiResearchAdapter({ apiKey: "test", textModel: "gemini-2.5-flash" });
  Object.assign(adapter, { ai: { models: { generateContent: async () => ({
    text: "Source-backed notes.",
    modelVersion: "gemini-2.5-flash",
    ...(reportedUsage ? { usageMetadata: {
      promptTokenCount: 200, candidatesTokenCount: 50, thoughtsTokenCount: 100, cachedContentTokenCount: 20
    } } : {}),
    candidates: []
  }) } } });
  return adapter;
}

it("research preserves provider-reported billed tokens", async () => {
  await expect(researchFixture().search({ query: "cryptography", purpose: "chapter-research" })).resolves.toMatchObject({
    provider: "gemini", model: "gemini-2.5-flash",
    usage: { promptTokens: 200, outputTokens: 150, reasoningTokens: 100, cacheHitTokens: 20 }
  });
});

it("research SDK usage reaches the project ledger and durable trace once", async () => {
  vi.clearAllMocks();
  const logger = createRunLogger({ id: "research", name: "generate-book", data: { projectId: "p", generationJobId: "job" } } as Parameters<typeof createRunLogger>[0]);
  await new LoggingResearchAdapter(researchFixture(), logger, "job", "p").search({ query: "cryptography", purpose: "chapter-research" });
  expect(prisma.providerCallLog.create).toHaveBeenCalledExactlyOnceWith({ data: expect.objectContaining({
    projectId: "p", generationJobId: "job", provider: "gemini", model: "gemini-2.5-flash",
    promptTokens: 200, outputTokens: 150, costHint: expect.any(Number),
    metadata: expect.objectContaining({ operation: "research.search", provisional: false, reasoningTokens: 100 })
  }) });
  const entry = (await readRunLog(logger.filePath)).trim().split("\n")
    .map((line) => JSON.parse(line)).find((event) => event.event === "research.search.response");
  expect(entry.result.usage).toMatchObject({ outputTokens: 150, reasoningTokens: 100 });
});

it.each<Provider>(["openai", "gemini"])("ledger settles paid %s tool and raw stream failures", async (provider) => {
  for (const operation of ["generateWithTools", "streamText"] as const) {
    vi.clearAllMocks();
    const run = logged(fixture(provider, ["incomplete"]).adapter);
    await expect(invoke(run.adapter, operation)).rejects.toThrow(/incomplete/);
    expectSettledTextUsage();
  }
});

it("stream without reported usage stays provisional and unpriced", async () => {
  vi.clearAllMocks();
  const inner = fixture("openai").adapter;
  inner.streamText = async function* () { yield "An unmetered answer."; };
  await invoke(logged(inner).adapter, "streamText");
  expect(prisma.providerCallLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    costHint: null,
    metadata: expect.objectContaining({ provisional: true, liveStatus: "settled", outputTokensEstimated: true })
  }) }));
});

it("unknown research usage stays unknown instead of an invented zero-dollar call", async () => {
  vi.clearAllMocks();
  const logger = createRunLogger({ id: "unmetered-research", name: "generate-book", data: { projectId: "p" } } as Parameters<typeof createRunLogger>[0]);
  const result = await new LoggingResearchAdapter(researchFixture(false), logger, undefined, "p").search({ query: "test" });
  expect(result.usage).toBeUndefined();
  expect(prisma.providerCallLog.create).not.toHaveBeenCalled();
});

it("keeps usage already observed when a stream later throws an unstructured error", async () => {
  vi.clearAllMocks();
  const inner = fixture("openai").adapter;
  const stream = inner.streamText.bind(inner);
  inner.streamText = async function* (request) {
    yield* stream(request);
    throw new Error("stream disconnected after usage");
  };
  await expect(invoke(logged(inner).adapter, "streamText")).rejects.toThrow("stream disconnected after usage");
  expectSettledTextUsage();
});
