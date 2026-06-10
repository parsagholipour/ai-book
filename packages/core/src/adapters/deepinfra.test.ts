import { describe, expect, it } from "vitest";
import { DeepInfraAdapter } from "./deepinfra.js";

describe("DeepInfraAdapter", () => {
  it("sends DeepInfra reasoning controls to text requests", async () => {
    const enabledRequests: any[] = [];
    const lowEffortRequests: any[] = [];
    const disabledRequests: any[] = [];
    const thinkingAdapter = new DeepInfraAdapter({
      apiKey: "test-key",
      model: "deepseek-ai/DeepSeek-V4-Pro",
      thinkingEnabled: true
    });
    const lowEffortAdapter = new DeepInfraAdapter({
      apiKey: "test-key",
      model: "deepseek-ai/DeepSeek-V4-Pro",
      thinkingEffort: "low"
    });
    const defaultAdapter = new DeepInfraAdapter({
      apiKey: "test-key",
      model: "deepseek-ai/DeepSeek-V4-Pro"
    });
    (thinkingAdapter as any).client = mockOpenAiClient(enabledRequests);
    (lowEffortAdapter as any).client = mockOpenAiClient(lowEffortRequests);
    (defaultAdapter as any).client = mockOpenAiClient(disabledRequests);

    await thinkingAdapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });
    await lowEffortAdapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });
    await defaultAdapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });

    expect(enabledRequests[0]).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
      reasoning_effort: "high"
    });
    expect(lowEffortRequests[0]).toMatchObject({
      reasoning: { enabled: true, effort: "low" },
      reasoning_effort: "low"
    });
    expect(disabledRequests[0]).toMatchObject({
      reasoning: { enabled: false },
      reasoning_effort: "none"
    });
  });
});

function mockOpenAiClient(requests: any[]) {
  return {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          return {
            choices: [{ message: { content: "A generated response." } }],
            usage: { prompt_tokens: 3, completion_tokens: 4, prompt_cache_hit_tokens: 1 }
          };
        }
      }
    }
  };
}
