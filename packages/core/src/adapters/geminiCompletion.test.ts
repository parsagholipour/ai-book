import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GeminiTextAdapter } from "./gemini.js";

describe("Gemini incomplete responses", () => {
  it.each([false, true])("rejects truncated text and JSON, retaining paid usage (stream=%s)", async (streaming) => {
    const adapter = new GeminiTextAdapter({ apiKey: "test-key", textModel: "gemini-3.7-flash", thinkingEffort: "high" });
    const response = {
      text: '{"value":"partial"}', candidates: [{ finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 12, thoughtsTokenCount: 100 }
    };
    Object.assign(adapter, { ai: { models: {
      generateContent: async () => response,
      generateContentStream: async function* () { yield response; }
    } } });
    const options = { messages: [{ role: "user" as const, content: "Write." }], ...(streaming ? { onOutputTextChunk: async () => {} } : {}) };
    const failure = { name: "GeminiResponseError", message: expect.stringContaining("MAX_TOKENS"), provider: "gemini", usage: { promptTokens: 20, outputTokens: 112 } };
    await expect(adapter.generateText(options)).rejects.toMatchObject(failure);
    await expect(adapter.generateJson({ ...options, schema: z.object({ value: z.string() }) })).rejects.toMatchObject(failure);
  });

  it("reserves reasoning space for an elevated composed chapter", async () => {
    const requests: Array<{ config: { maxOutputTokens: number } }> = [];
    const adapter = new GeminiTextAdapter({ apiKey: "test-key", textModel: "gemini-3.7-flash", thinkingEffort: "high" });
    Object.assign(adapter, { ai: { models: { generateContent: async (request: { config: { maxOutputTokens: number } }) => {
      requests.push(request); return { text: "Complete.", candidates: [{ finishReason: "STOP" }] };
    } } } });
    await adapter.generateText({ purpose: "compose-chapter", maxTokens: 10_608, messages: [{ role: "user", content: "Write." }] });
    expect(requests[0]!.config.maxOutputTokens).toBe(32_000);
  });
});
