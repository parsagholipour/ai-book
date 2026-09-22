import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateJsonWithRetry } from "../generation/generateJsonWithRetry.js";
import { GeminiTextAdapter } from "./gemini.js";
import { OpenAITextAdapter } from "./openai.js";

const schema = z.object({ value: z.string() });
type Reply = "budget" | "schema" | "syntax" | "ok";

describe.each(["openai", "gemini"] as const)("%s output-budget retries", (provider) => {
  it.each([false, true])("widens the effective provider budget and retains it through schema repair (stream=%s)", async (streaming) => {
    const { adapter, limits } = fixture(provider, ["budget", "schema", "ok"]);
    const result = await generateJsonWithRetry(adapter, {
      messages: [{ role: "user", content: "Plan chapter forms." }],
      purpose: "plan-chapter-forms", maxTokens: 5_000, schema,
      ...(streaming ? { onOutputTextChunk: () => undefined } : {})
    });

    expect(result.data).toEqual({ value: "ok" });
    const effective = provider === "openai" ? 48_000 : 32_000;
    expect(limits).toEqual([effective, effective * 1.5, effective * 1.5]);
  });

  it("retains a widened ordinary limit through syntax repair", async () => {
    const { adapter, limits } = fixture(provider, ["budget", "syntax", "ok"]);
    await generateJsonWithRetry(adapter, { messages: [], maxTokens: 10_000, schema });
    expect(limits).toEqual([10_000, 15_000, 15_000]);
  });

  it("bounds budget exhaustion to one wider retry and preserves the final paid usage", async () => {
    const { adapter, limits } = fixture(provider, ["budget", "budget"]);
    await expect(generateJsonWithRetry(adapter, {
      messages: [], purpose: "plan-chapter-forms", maxTokens: 5_000, schema, repairAttempts: 0
    })).rejects.toMatchObject({ provider, usage: { promptTokens: 100, outputTokens: 10 } });
    const effective = provider === "openai" ? 48_000 : 32_000;
    expect(limits).toEqual([effective, effective * 1.5]);
  });

  it("caps widening at the model limit and retains that cap through repair", async () => {
    const { adapter, limits } = fixture(provider, ["budget", "schema", "ok"]);
    const initial = provider === "openai" ? 100_000 : 50_000;
    const cap = provider === "openai" ? 128_000 : 65_536;
    await generateJsonWithRetry(adapter, { messages: [], maxTokens: initial, schema });
    expect(limits).toEqual([initial, cap, cap]);
  });

  it("returns the original failure without another paid attempt when already at the ceiling", async () => {
    const { adapter, limits } = fixture(provider, ["budget"]);
    const cap = provider === "openai" ? 128_000 : 65_536;
    await expect(generateJsonWithRetry(adapter, { messages: [], maxTokens: cap, schema })).rejects.toMatchObject({
      provider, usage: { promptTokens: 100, outputTokens: 10 }, outputBudget: { maxTokens: cap, retryCeiling: cap }
    });
    expect(limits).toEqual([cap]);
  });

  it("leaves uncapped calls uncapped and does not invent a budget retry", async () => {
    const { adapter, limits } = fixture(provider, ["budget"]);
    await expect(generateJsonWithRetry(adapter, { messages: [], schema })).rejects.toMatchObject({ provider });
    expect(limits).toEqual([undefined]);
  });

  it("pins the route across budget and schema retries", async () => {
    const { adapter, limits } = fixture(provider, ["budget", "schema", "ok"]);
    let bindings = 0;
    Object.assign(adapter, { bindForCall: async () => { bindings += 1; return { adapter }; } });
    await generateJsonWithRetry(adapter, { messages: [], maxTokens: 5_000, purpose: "plan-chapter-forms", schema });
    expect(bindings).toBe(1);
    expect(limits).toHaveLength(3);
  });
});

it.each([48_000, 50_000])("OpenAI respects remaining context when widening from %s", async (maxTokens) => {
  const { adapter, limits } = fixture("openai", ["budget", "ok"], 1_000_000);
  const call = generateJsonWithRetry(adapter, { messages: [], maxTokens, schema });
  if (maxTokens < 50_000) {
    await expect(call).resolves.toMatchObject({ data: { value: "ok" } });
    expect(limits).toEqual([maxTokens, 50_000]);
  } else {
    await expect(call).rejects.toMatchObject({ outputBudget: { maxTokens, retryCeiling: 50_000 } });
    expect(limits).toEqual([maxTokens]);
  }
});

describe.each([false, true])("OpenAI resolved-model limits (stream=%s)", (streaming) => {
  it.each([48_000, 50_000])("retains the requested model's ceiling when the response model ID is unknown (budget=%s)", async (maxTokens) => {
    const { adapter, limits } = fixture("openai", ["budget", "budget"], 1_000_000, "provider-resolved-model");
    await expect(generateJsonWithRetry(adapter, {
      messages: [], maxTokens, schema,
      ...(streaming ? { onOutputTextChunk: () => undefined } : {})
    })).rejects.toMatchObject({
      model: "provider-resolved-model",
      usage: { promptTokens: 1_000_000, outputTokens: 10 },
      outputBudget: { maxTokens: 50_000, retryCeiling: 50_000 }
    });
    expect(limits).toEqual(maxTokens === 48_000 ? [48_000, 50_000] : [50_000]);
  });
});

function fixture(provider: "openai" | "gemini", replies: Reply[], promptTokens = 100, responseModel?: string) {
  const limits: Array<number | undefined> = [];
  const next = () => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected provider call");
    return {
      reply,
      text: reply === "budget" ? "" : reply === "schema" ? '{"value":1}' : reply === "syntax" ? '{"value":' : '{"value":"ok"}'
    };
  };
  if (provider === "openai") {
    const adapter = new OpenAITextAdapter({ apiKey: "test-key", model: "gpt-5.6-sol", thinkingEffort: "max" });
    Object.assign(adapter, { client: { responses: { create: async (request: { max_output_tokens?: number; stream?: boolean }) => {
      limits.push(request.max_output_tokens);
      const { reply, text } = next();
      const response = {
        ...(responseModel ? { model: responseModel } : {}),
        output_text: text, status: reply === "budget" ? "incomplete" : "completed",
        ...(reply === "budget" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        usage: { input_tokens: promptTokens, output_tokens: 10 }
      };
      return request.stream ? events([
        { type: "response.output_text.delta", delta: text },
        { type: `response.${response.status}`, response }
      ]) : response;
    } } } });
    return { adapter, limits };
  }
  const adapter = new GeminiTextAdapter({ apiKey: "test-key", textModel: "gemini-3.7-flash", thinkingEffort: "high" });
  const generateContent = async (request: { config: { maxOutputTokens?: number } }) => {
    limits.push(request.config.maxOutputTokens);
    const { reply, text } = next();
    return { text, candidates: [{ finishReason: reply === "budget" ? "MAX_TOKENS" : "STOP" }], usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 10 } };
  };
  Object.assign(adapter, { ai: { models: {
    generateContent,
    generateContentStream: async (request: { config: { maxOutputTokens?: number } }) => events([await generateContent(request)])
  } } });
  return { adapter, limits };
}

async function* events<T>(items: T[]) { yield* items; }
