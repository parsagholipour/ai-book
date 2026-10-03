import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeTextModelAdapter, OpenAITextAdapter } from "@book-maker/core";

const mocks = vi.hoisted(() => ({ create: vi.fn(async () => ({ id: "live" })), update: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: { providerCallLog: mocks }, Prisma: {} }));
vi.mock("../runtime/config.js", () => ({ config: { MOCK_AI: false } }));
import { LoggingTextModelAdapter } from "./loggedAdapters.js";
beforeEach(() => vi.clearAllMocks());

it("settles exact observed usage even when a successful result omits usage", async () => {
  const inner = new FakeTextModelAdapter();
  inner.generateJson = async options => {
    await options.onProviderRequest?.({ provider: "openai", model: "gpt-6-luna", requestedMaxTokens: 4000, effectiveMaxTokens: 4000 });
    await options.onProviderUsage?.({ promptTokens: 1000, outputTokens: 100 });
    return { data: options.schema.parse({ value: "ok" }), text: '{"value":"ok"}', provider: "openai", model: "gpt-6-luna" };
  };
  const logged = new LoggingTextModelAdapter(inner, { filePath: "test", append: async () => new Date().toISOString() }, undefined, undefined,
    { provider: "openai", model: "gpt-6-luna" });
  await logged.generateJson({ purpose: "extract-excerpts", messages: [], schema: z.object({ value: z.string() }) });
  expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({
    promptTokens: 1000, outputTokens: 100, costHint: expect.any(Number),
    metadata: expect.objectContaining({ provisional: false })
  }) }));
});

it("labels the real blank-line early stop as unknown cost while preserving its valid JSON", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const inner = new OpenAITextAdapter({ apiKey: "fixture", model: "gpt-6-luna", thinkingEffort: "none" });
    Object.defineProperty(inner, "client", { value: { responses: { create: async () => (async function* () {
      yield { type: "response.output_text.delta", delta: '{"value":"ok"}' };
      for (let i = 0; i < 100; i++) yield { type: "response.output_text.delta", delta: " \n" };
      throw new Error("The runaway guard should have stopped the stream");
    })() } } });
    const logged = new LoggingTextModelAdapter(inner, { filePath: "test", append: async () => new Date().toISOString() }, undefined, undefined,
      { provider: "openai", model: "gpt-6-luna" });
    const result = await logged.generateJson({ purpose: "extract-excerpts", messages: [], schema: z.object({ value: z.string() }) });
    expect(result.data).toEqual({ value: "ok" });
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ costHint: null,
      metadata: expect.objectContaining({ costStatus: "unknown_usage", usageUnavailableReason: "whitespace_runaway", provisional: true })
    }) }));
  } finally { warn.mockRestore(); }
});
