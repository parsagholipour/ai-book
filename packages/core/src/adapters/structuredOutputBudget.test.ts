import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAITextAdapter } from "./openai.js";
import { GeminiTextAdapter } from "./gemini.js";
import { generateJsonWithRetry } from "../generation/generateJsonWithRetry.js";

const stages = ["describe-pages", "select-cover-design", "review-dossier-provenance", "review-chapter-edit-acceptance", "review-page", "generate-chapter-brief", "final-book-qa", "audit-page-style", "generate-page", "revise-page", "author-assist-continue", "author-assist-proofread", "author-chapter-feedback"];
describe.each(["openai", "gemini"] as const)("%s structured allowance", (provider) => {
  it.each(stages)("reserves reasoning room for %s and widens from the effective limit", async (purpose) => {
    const requests: number[] = [];
    const adapter = provider === "openai"
      ? new OpenAITextAdapter({ apiKey: "fixture", thinkingEffort: "medium" })
      : new GeminiTextAdapter({ apiKey: "fixture", thinkingEffort: "medium" });
    const response = (limit: number) => {
      requests.push(limit);
      return { incomplete: requests.length === 1, text: '{"value":"ok"}' };
    };
    if (provider === "openai") {
      Object.assign(adapter, { client: { responses: { create: async (request: { max_output_tokens: number }) => {
        const result = response(request.max_output_tokens);
        return { status: result.incomplete ? "incomplete" : "completed", output_text: result.text,
          incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 100, output_tokens: 100 } };
      } } } });
    } else {
      Object.assign(adapter, { ai: { models: { generateContent: async (request: { config: { maxOutputTokens: number } }) => {
        const result = response(request.config.maxOutputTokens);
        return { text: result.text, candidates: [{ finishReason: result.incomplete ? "MAX_TOKENS" : "STOP" }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 } };
      } } } });
    }
    await generateJsonWithRetry(adapter, { messages: [], purpose, maxTokens: 1_200, schema: z.object({ value: z.string() }) });
    expect(requests).toEqual([8_000, 12_000]);
  });
});

it.each([undefined, "none", "minimal"] as const)("keeps small caps for %s effort and leaves unknown stages alone", async (thinkingEffort) => {
  const adapter = new OpenAITextAdapter({ apiKey: "fixture", thinkingEffort });
  const limits: Array<number | undefined> = [];
  Object.assign(adapter, { client: { responses: { create: async (request: { max_output_tokens?: number }) => {
    limits.push(request.max_output_tokens);
    return { output_text: '{"value":"ok"}', status: "completed" };
  } } } });
  for (const maxTokens of [undefined, 300, 20_000]) {
    await adapter.generateJson({ messages: [], purpose: "select-cover-design", ...(maxTokens === undefined ? {} : { maxTokens }), schema: z.object({ value: z.string() }) });
  }
  expect(limits).toEqual([undefined, 300, 20_000]);
});

it("preserves explicit larger limits and unrelated calls with low reasoning", async () => {
  const adapter = new OpenAITextAdapter({ apiKey: "fixture", thinkingEffort: "low" });
  const limits: Array<number | undefined> = [];
  Object.assign(adapter, { client: { responses: { create: async (request: { max_output_tokens?: number }) => {
    limits.push(request.max_output_tokens);
    return { output_text: '{"value":"ok"}', status: "completed" };
  } } } });
  for (const options of [
    { purpose: "describe-pages", maxTokens: 1_200 },
    { purpose: "describe-pages", maxTokens: 20_000 },
    { purpose: "unrelated-stage", maxTokens: 300 },
    { purpose: "describe-pages" }
  ]) await adapter.generateJson({ ...options, messages: [], schema: z.object({ value: z.string() }) });
  expect(limits).toEqual([4_000, 20_000, 300, undefined]);
});
