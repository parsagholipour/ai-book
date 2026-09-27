import { expect, it, vi } from "vitest";
import { z } from "zod";
import OpenAI from "openai";
import { OpenAITextAdapter } from "./openai.js";
import { generateJsonWithRetry } from "../generation/generateJsonWithRetry.js";
import { isCancellationError, isRecoverableNetworkError, isTextProviderFallbackError } from "./retry.js";
import captured from "./testing/quickReviewRunaway.json" with { type: "json" };

// The capture retains only head/tail. Supply a minimal object prefix and replay
// the observed invalid tail verbatim, fragmented as it would arrive over SSE.
const tail = captured.partialOutput.tail.slice(captured.partialOutput.tail.indexOf(',"styleAudit"'));
const malformed = '{"pages":[{"pageIndex":1,"styleAudit"' + tail;
const response = (text: string) => ({ status: "completed", output_text: text, model: "gpt-6-luna" });
function setup(replies: string[], chunkSize = 7) {
  const adapter = new OpenAITextAdapter({ apiKey: "test", model: "gpt-6-luna", thinkingEffort: "low" });
  const closed: number[] = [], consumed: number[] = [];
  const create = vi.fn(async (_request: Record<string, unknown>) => {
    const call = create.mock.calls.length - 1;
    const text = replies[call]!;
    return (async function* () {
      try {
        for (let i = 0; i < text.length; i += chunkSize) {
          consumed[call] = Math.min(text.length, i + chunkSize);
          yield { type: "response.output_text.delta", delta: text.slice(i, i + chunkSize) };
        }
        if (text === malformed) yield { type: "response.incomplete", response: {
          status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } };
        else yield { type: "response.completed", response: response(text) };
      } finally { closed.push(call); }
    })();
  });
  Object.defineProperty(adapter, "client", { value: { responses: { create } } });
  return { adapter, create, consumed, closed };
}

it.each([1, 7, 256])("closes the captured malformed property loop early across chunks of %i", async chunkSize => {
  const test = setup([malformed], chunkSize);
  const error = await test.adapter.generateJson({ schema: z.object({ pages: z.array(z.unknown()) }),
    messages: [], maxTokens: 24_000, onOutputTextChunk: () => {} }).catch((error: unknown) => error);
  expect(error).toMatchObject({ name: "JsonOutputRepetitionError", provider: "openai", model: "gpt-6-luna" });
  expect(error).not.toHaveProperty("usage"); // No terminal usage was received; never invent zero usage.
  expect(test.consumed[0]).toBeLessThan(malformed.length / 2);
  expect(test.closed).toEqual([0]);
  expect(isCancellationError(error)).toBe(false);
  expect(isRecoverableNetworkError(error)).toBe(false);
  expect(isTextProviderFallbackError(error)).toBe(false);
});

it("repairs malformed repetition within the same allowance without raising the output cap", async () => {
  const test = setup([malformed, '{"pages":[]}']);
  const budget = { limit: 2, used: 0, outputWidened: false };
  const result = await generateJsonWithRetry(test.adapter, { schema: z.object({ pages: z.array(z.unknown()) }),
    messages: [], maxTokens: 24_000, textAttemptBudget: budget, onOutputTextChunk: () => {} });
  expect(result.data).toEqual({ pages: [] });
  expect(test.create.mock.calls.map(call => call[0].max_output_tokens)).toEqual([24_000, 24_000]);
  expect(budget).toEqual({ limit: 2, used: 2, outputWidened: false });
  expect(JSON.stringify(test.create.mock.calls[1])).toContain("repeated property names");
});

it("does not reject repeated fields in separate objects, array values, escaped prose, or long reviews", async () => {
  const text = JSON.stringify({ pages: Array.from({ length: 40 }, (_, i) => ({ pageIndex: i + 1,
    styleAudit: null, prose: ('A child reads: ,"styleAudit" \\ beside {the stream}. ').repeat(60),
    values: Array(30).fill("styleAudit") })) });
  const test = setup([text], 137);
  const result = await test.adapter.generateJson({ schema: z.object({ pages: z.array(z.unknown()) }),
    messages: [], onOutputTextChunk: () => {} });
  expect(result.data.pages).toHaveLength(40);
  expect(test.consumed[0]).toBe(text.length);
});

it("stops after the allowed repair if the model repeats the same failure", async () => {
  const test = setup([malformed, malformed]);
  const budget = { limit: 5, used: 0, outputWidened: false };
  await expect(generateJsonWithRetry(test.adapter, { schema: z.object({}), messages: [], maxTokens: 24_000,
    textAttemptBudget: budget, onOutputTextChunk: () => {} })).rejects.toMatchObject({ name: "JsonOutputRepetitionError" });
  expect(test.create).toHaveBeenCalledTimes(2);
  expect(budget).toEqual({ limit: 5, used: 2, outputWidened: false });
  expect(test.closed).toEqual([0, 1]);
});

it("preserves user cancellation and does not repair it", async () => {
  const test = setup([malformed]);
  const controller = new AbortController();
  controller.abort();
  await expect(generateJsonWithRetry(test.adapter, { schema: z.object({}), messages: [],
    signal: controller.signal, onOutputTextChunk: () => {} })).rejects.toBe(controller.signal.reason);
  expect(test.create).toHaveBeenCalledTimes(1);
  expect(test.closed).toEqual([0]);
});

it("keeps provider usage for non-streamed malformed output without misclassifying it as budget exhaustion", async () => {
  const test = setup([]);
  const onProviderUsage = vi.fn();
  Object.defineProperty(test.adapter, "client", { value: { responses: { create: async () => ({
    ...response(malformed), status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    usage: { input_tokens: 100, output_tokens: 900, total_tokens: 1000 }
  }) } } });
  await expect(test.adapter.generateJson({ schema: z.object({}), messages: [], onProviderUsage })).rejects.toMatchObject({
    name: "JsonOutputRepetitionError", usage: { promptTokens: 100, outputTokens: 900 }
  });
  expect(onProviderUsage).toHaveBeenCalledOnce();
});

it("aborts the real SDK stream request when the guard closes its iterator", async () => {
  const adapter = new OpenAITextAdapter({ apiKey: "test" });
  let requestSignal: AbortSignal | undefined | null;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requestSignal = init?.signal;
    const wire = JSON.stringify({ type: "response.output_text.delta", delta: malformed });
    return new Response(`event: response.output_text.delta\ndata: ${wire}\n\n`, {
      headers: { "content-type": "text/event-stream" }
    });
  });
  Object.defineProperty(adapter, "client", { value: new OpenAI({ apiKey: "test", fetch }) });
  await expect(adapter.generateJson({ schema: z.object({}), messages: [],
    onOutputTextChunk: () => {} })).rejects.toMatchObject({ name: "JsonOutputRepetitionError" });
  expect(fetch).toHaveBeenCalledOnce();
  expect(requestSignal?.aborted).toBe(true);
});

it("does not apply JSON validation to ordinary text generation", async () => {
  const text = "Here is malformed JSON: " + malformed;
  const test = setup([text]);
  expect((await test.adapter.generateText({ messages: [], onOutputTextChunk: () => {} })).text).toBe(text);
});
