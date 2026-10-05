import { expect, it, vi } from "vitest";
import OpenAI from "openai";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { OpenAITextAdapter } from "../adapters/openai.js";
import { reportTextProviderRequest } from "../adapters/textProviderRequest.js";
import { TextAttemptBudgetExhaustedError } from "../adapters/textAttemptBudget.js";
import { ProviderHttpError, withRecoverableNetworkRetry } from "../adapters/retry.js";
import { createProjectSchema } from "../schemas/book.js";
import { generateChapterProse } from "./generateChapterProse.js";
import captured from "./testing/bolsonaroProseRunaway.json" with { type: "json" };

const request = { messages: [{ role: "user" as const, content: "Write the chapter." }], purpose: "compose-chapter", maxTokens: 12912 };
const text = captured.partialOutput.tail;
function fake() { return new FakeTextModelAdapter(createProjectSchema.parse({ prompt: "A practical guide", category: "BUSINESS", targetPages: 20 })); }

it("pins routing and shares the physical allowance across recovery and network retries", async () => {
  const adapter = fake();
  const budget = { limit: 3, used: 0, outputWidened: false };
  const generate = vi.spyOn(adapter, "generateText").mockImplementation(options => withRecoverableNetworkRetry(async () => {
    await reportTextProviderRequest(options, "fixture", "fixture", options.maxTokens);
    if (budget.used === 1) await options.onOutputTextChunk?.(text);
    throw new ProviderHttpError("unavailable", { status: 503 });
  }, { delayMs: 0 }));
  const bind = vi.fn(async () => ({ adapter }));
  Object.assign(adapter, { bindForCall: bind });
  await expect(generateChapterProse(adapter, { ...request, textAttemptBudget: budget })).rejects.toBeInstanceOf(TextAttemptBudgetExhaustedError);
  expect(bind).toHaveBeenCalledOnce();
  expect(generate).toHaveBeenCalledTimes(2);
  expect(budget.used).toBe(3);
});

it("starts a new repetition window on each physical request", async () => {
  const adapter = fake();
  const paragraph = text.slice(text.indexOf("Maya looks"), text.indexOf("**Relative:**", text.indexOf("Maya looks"))).trim();
  const threeCopies = Array(3).fill(paragraph).join("\n\n") + "\n\n";
  let physical = 0;
  const generate = vi.spyOn(adapter, "generateText").mockImplementation(options => withRecoverableNetworkRetry(async () => {
    await reportTextProviderRequest(options, "fixture", "fixture", options.maxTokens);
    physical++;
    await options.onOutputTextChunk?.(threeCopies);
    if (physical === 1) throw new ProviderHttpError("unavailable", { status: 503 });
    return { text: threeCopies, provider: "fixture", model: "fixture" };
  }, { delayMs: 0 }));
  expect((await generateChapterProse(adapter, request)).text).toBe(threeCopies);
  expect(generate).toHaveBeenCalledOnce();
  expect(physical).toBe(2);
});

it("does not replay cancellation or unrelated failures", async () => {
  for (const error of [Object.assign(new Error("Stopped"), { name: "StopRequestedError" }), new Error("permission denied")]) {
    const adapter = fake();
    const generate = vi.spyOn(adapter, "generateText").mockRejectedValue(error);
    await expect(generateChapterProse(adapter, request)).rejects.toBe(error);
    expect(generate).toHaveBeenCalledOnce();
  }
});

it("honors the effective output ceiling and retains the final paid failure", async () => {
  const adapter = fake();
  const error = Object.assign(new Error(captured.message), { outputBudget: { maxTokens: 48000, retryCeiling: 48000 }, usage: captured.usage });
  const generate = vi.spyOn(adapter, "generateText").mockRejectedValue(error);
  await expect(generateChapterProse(adapter, request)).rejects.toBe(error);
  expect(generate).toHaveBeenCalledOnce();
});

it("checks non-streaming adapters too and never accepts repeated prose", async () => {
  const adapter = fake();
  const generate = vi.spyOn(adapter, "generateText").mockResolvedValue({ text, provider: "fixture", model: "fixture" });
  await expect(generateChapterProse(adapter, request)).rejects.toMatchObject({ name: "ProseOutputRepetitionError" });
  expect(generate).toHaveBeenCalledTimes(2);
});

it("aborts the real SDK request when the prose observer closes the iterator", async () => {
  const adapter = new OpenAITextAdapter({ apiKey: "fixture" });
  let requestSignal: AbortSignal | undefined | null;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requestSignal = init?.signal;
    const wire = JSON.stringify({ type: "response.output_text.delta", delta: text });
    return new Response(`event: response.output_text.delta\ndata: ${wire}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  Object.assign(adapter, { client: new OpenAI({ apiKey: "fixture", fetch }) });
  await expect(generateChapterProse(adapter, request, false)).rejects.toMatchObject({ name: "ProseOutputRepetitionError", context: { reason: "repeated_prose" } });
  expect(fetch).toHaveBeenCalledOnce();
  expect(requestSignal?.aborted).toBe(true);
});
