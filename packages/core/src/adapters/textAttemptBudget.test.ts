import { expect, it } from "vitest";
import { z } from "zod";
import { generateJsonWithRetry } from "../generation/generateJsonWithRetry.js";
import { OpenAITextAdapter } from "./openai.js";
import { ProviderStreamInterruptedError, isRecoverableNetworkError, isTextProviderFallbackError, withRecoverableNetworkRetry } from "./retry.js";
import { FallbackTextModelAdapter } from "./textFallback.js";
import { TextAttemptBudgetExhaustedError } from "./textAttemptBudget.js";

it("retries the recorded missing-terminal stream but never cancellation or token exhaustion", () => {
  const error = new ProviderStreamInterruptedError("OpenAI response stream ended without a completion event.");
  expect(isRecoverableNetworkError(error)).toBe(true);
  expect(isTextProviderFallbackError(error)).toBe(true);
  expect(isRecoverableNetworkError(Object.assign(new Error("request aborted"), { name: "AbortError" }))).toBe(false);
  expect(isRecoverableNetworkError(new Error("OpenAI response was incomplete: max_output_tokens."))).toBe(false);
});

it("shares five physical calls across fallback and network retry", async () => {
  let requests = 0;
  const primary = new OpenAITextAdapter({ apiKey: "fixture", maxRetries: 0 });
  const fallback = new OpenAITextAdapter({ apiKey: "fixture", maxRetries: 0 });
  Object.assign(primary, { client: { responses: { create: async () => {
    requests++;
    throw new ProviderStreamInterruptedError("stream lost");
  } } } });
  Object.assign(fallback, { client: { responses: { create: async () => {
    requests++;
    throw new ProviderStreamInterruptedError("stream lost");
  } } } });
  const pair = new FallbackTextModelAdapter({
    primary: { adapter: primary, selection: { provider: "openai", model: "primary" } },
    fallback: { adapter: fallback, selection: { provider: "openai", model: "fallback" } },
    shouldFallback: isTextProviderFallbackError,
    // Primary, primary, fallback, then primary, fallback: the same-model retry
    // is one of the five, once per call, never a sixth.
    primaryRetryDelayMs: () => 0
  });
  const adapter = Object.assign(Object.create(pair), {
    generateJson: <T>(options: Parameters<OpenAITextAdapter["generateJson"]>[0]) =>
      withRecoverableNetworkRetry(() => pair.generateJson<T>(options as never), { delayMs: 0 })
  });
  await expect(generateJsonWithRetry(adapter, {
    messages: [], schema: z.object({ value: z.string() }), repairAttempts: 2
  })).rejects.toBeInstanceOf(TextAttemptBudgetExhaustedError);
  expect(requests).toBe(5);
});

it("keeps widening, schema repair and network recovery inside the same allowance", async () => {
  let requests = 0;
  const wireLimits: number[] = [];
  const inner = new OpenAITextAdapter({ apiKey: "fixture", maxRetries: 0 });
  Object.assign(inner, { client: { responses: { create: async (request: { max_output_tokens: number }) => {
    requests++; wireLimits.push(request.max_output_tokens);
    if (requests === 1) return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    if (requests <= 3) return { status: "completed", output_text: '{"value":2}' };
    throw new ProviderStreamInterruptedError("stream lost");
  } } } });
  const adapter = Object.assign(Object.create(inner), {
    generateJson: <T>(options: Parameters<OpenAITextAdapter["generateJson"]>[0]) =>
      withRecoverableNetworkRetry(() => inner.generateJson<T>(options as never), { delayMs: 0 })
  });
  await expect(generateJsonWithRetry(adapter, {
    messages: [], schema: z.object({ value: z.string() }), maxTokens: 100, repairAttempts: 2
  })).rejects.toBeInstanceOf(TextAttemptBudgetExhaustedError);
  expect(requests).toBe(5);
  expect(wireLimits).toEqual([100, 150, 150, 150, 150]);
});
