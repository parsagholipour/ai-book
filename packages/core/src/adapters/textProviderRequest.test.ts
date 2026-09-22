import { expect, it, vi } from "vitest";
import { OpenAITextAdapter } from "./openai.js";
import { GeminiTextAdapter } from "./gemini.js";
import { OpenRouterAdapter } from "./openrouter.js";

it.each(["openai", "gemini", "openrouter"])("a failing trace observer cannot fail a direct %s call", async (provider) => {
  const adapter = provider === "openai" ? new OpenAITextAdapter({ apiKey: "test" })
    : provider === "gemini" ? new GeminiTextAdapter({ apiKey: "test" }) : new OpenRouterAdapter({ apiKey: "test" });
  const create = vi.fn(async () => ({
    text: "Complete.", output_text: "Complete.", status: "completed",
    choices: [{ message: { content: "Complete." } }],
    usage: { input_tokens: 5, output_tokens: 9, prompt_tokens: 5, completion_tokens: 9 },
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 }
  }));
  if (provider === "gemini") Object.assign(adapter, { ai: { models: { generateContent: create } } });
  else Object.assign(adapter, { client: { responses: { create }, chat: { completions: { create } } } });
  const onProviderRequest = vi.fn(() => { throw new Error("synchronous diagnostic failure"); });
  const onProviderUsage = vi.fn(async () => { throw new Error("asynchronous diagnostic failure"); });
  await expect(adapter.generateText({ messages: [], maxTokens: 1000, onProviderRequest, onProviderUsage })).resolves.toMatchObject({ text: "Complete." });
  expect(create).toHaveBeenCalledOnce();
  expect(onProviderRequest).toHaveBeenCalledOnce();
  expect(onProviderUsage).toHaveBeenCalledOnce();
  // An absent provider reasoning count stays unknown, rather than being reported as zero.
  expect(onProviderUsage.mock.calls[0]).toEqual([expect.not.objectContaining({ reasoningTokens: expect.any(Number) })]);
});
