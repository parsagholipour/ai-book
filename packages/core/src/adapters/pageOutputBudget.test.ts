import { expect, it } from "vitest";
import { z } from "zod";
import { OpenAITextAdapter } from "./openai.js";
import { generateJsonWithRetry } from "../generation/generateJsonWithRetry.js";

// Recorded Premium rewrites exhausted their 3,200 total-token cap with these
// reasoning counts. Replay the wire boundary: a page still needs visible JSON.
it.each([3_083, 3_106, 3_200, 3_200])("fits a Premium rewrite after %i reasoning tokens without buying a truncated retry", async (reasoningTokens) => {
  const adapter = new OpenAITextAdapter({ apiKey: "fixture", model: "gpt-6-luna", thinkingEffort: "high" });
  const requests: Array<{ max_output_tokens: number; reasoning: { effort: string } }> = [];
  Object.assign(adapter, { client: { responses: { create: async (request: typeof requests[number]) => {
    requests.push(request);
    const fits = request.max_output_tokens >= reasoningTokens + 1_000;
    return { model: "gpt-6-luna", status: fits ? "completed" : "incomplete",
      incomplete_details: fits ? undefined : { reason: "max_output_tokens" },
      output_text: fits ? '{"markdown":"Rabbit waited for Turtle."}' : "",
      usage: { input_tokens: 2_000, output_tokens: fits ? reasoningTokens + 1_000 : request.max_output_tokens,
        output_tokens_details: { reasoning_tokens: reasoningTokens } } };
  } } } });
  await generateJsonWithRetry(adapter, { messages: [], purpose: "revise-page", maxTokens: 3_200,
    schema: z.object({ markdown: z.string() }) });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.reasoning.effort).toBe("high");
  expect(requests[0]?.max_output_tokens).toBeGreaterThanOrEqual(reasoningTokens + 1_000);
});

it("keeps the explicit batch-review allowance and selected high reasoning on the existing review route", async () => {
  const adapter = new OpenAITextAdapter({ apiKey: "fixture", model: "gpt-6-luna", thinkingEffort: "high" });
  const requests: Array<{ max_output_tokens: number; reasoning: { effort: string } }> = [];
  Object.assign(adapter, { client: { responses: { create: async (request: typeof requests[number]) => {
    requests.push(request); return { status: "completed", output_text: '{"issues":[]}' };
  } } } });
  await generateJsonWithRetry(adapter, { messages: [], purpose: "review-page", maxTokens: 24_000,
    schema: z.object({ issues: z.array(z.string()) }) });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ max_output_tokens: 24_000, reasoning: { effort: "high" } });
});
