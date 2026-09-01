import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenRouterAdapter } from "./openrouter.js";
import { OPENROUTER_GLM_53_FLASH_MODEL } from "./openrouterModels.js";

describe("OpenRouterAdapter", () => {
  it("requires OPENROUTER_API_KEY", () => {
    expect(() => new OpenRouterAdapter({ apiKey: undefined })).toThrow(/OPENROUTER_API_KEY/);
  });

  it("sends OpenRouter reasoning controls and defaults GLM Flash to high effort", async () => {
    const defaultRequests: unknown[] = [];
    const lowEffortRequests: unknown[] = [];
    const maxEffortRequests: unknown[] = [];
    const disabledRequests: unknown[] = [];
    const defaultAdapter = new OpenRouterAdapter({
      apiKey: "test-key",
      model: OPENROUTER_GLM_53_FLASH_MODEL
    });
    const lowEffortAdapter = new OpenRouterAdapter({
      apiKey: "test-key",
      model: OPENROUTER_GLM_53_FLASH_MODEL,
      thinkingEffort: "low"
    });
    const maxEffortAdapter = new OpenRouterAdapter({
      apiKey: "test-key",
      model: OPENROUTER_GLM_53_FLASH_MODEL,
      thinkingEffort: "max"
    });
    const disabledAdapter = new OpenRouterAdapter({
      apiKey: "test-key",
      model: OPENROUTER_GLM_53_FLASH_MODEL,
      thinkingEnabled: false
    });
    (defaultAdapter as unknown as { client: unknown }).client = mockOpenAiClient(defaultRequests);
    (lowEffortAdapter as unknown as { client: unknown }).client = mockOpenAiClient(lowEffortRequests);
    (maxEffortAdapter as unknown as { client: unknown }).client = mockOpenAiClient(maxEffortRequests);
    (disabledAdapter as unknown as { client: unknown }).client = mockOpenAiClient(disabledRequests);

    await defaultAdapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });
    await lowEffortAdapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });
    await maxEffortAdapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });
    await disabledAdapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });

    expect(defaultRequests[0]).toMatchObject({
      model: OPENROUTER_GLM_53_FLASH_MODEL,
      reasoning: { enabled: true, effort: "high" },
      reasoning_effort: "high"
    });
    expect(defaultRequests[0]).not.toHaveProperty("temperature");
    expect(defaultRequests[0]).not.toHaveProperty("max_tokens");
    expect(lowEffortRequests[0]).toMatchObject({
      reasoning: { enabled: true, effort: "low" },
      reasoning_effort: "low"
    });
    expect(maxEffortRequests[0]).toMatchObject({
      reasoning: { enabled: true, effort: "max" },
      reasoning_effort: "max"
    });
    expect(disabledRequests[0]).toMatchObject({
      reasoning: { enabled: true, effort: "low" },
      reasoning_effort: "low"
    });
  });

  it("sends temperature and max_tokens only when the call sets them", async () => {
    const requests: unknown[] = [];
    const adapter = new OpenRouterAdapter({
      apiKey: "test-key",
      model: OPENROUTER_GLM_53_FLASH_MODEL
    });
    (adapter as unknown as { client: unknown }).client = mockOpenAiClient(requests);

    await adapter.generateText({
      messages: [{ role: "user", content: "Draft a paragraph." }],
      temperature: 0,
      maxTokens: 128
    });

    expect(requests[0]).toMatchObject({ temperature: 0, max_tokens: 128 });
  });

  it("does not bypass response validation for chapter briefs", async () => {
    const adapter = new OpenRouterAdapter({
      apiKey: "test-key",
      model: OPENROUTER_GLM_53_FLASH_MODEL
    });
    (adapter as unknown as { client: unknown }).client = mockOpenAiClient([], `{"value":1}`);

    await expect(
      adapter.generateJson({
        purpose: "generate-chapter-brief",
        messages: [{ role: "user", content: "Return the value." }],
        schema: z.object({ value: z.string() })
      })
    ).rejects.toMatchObject({ name: "OpenRouterJsonValidationError" });
  });
});

function mockOpenAiClient(requests: unknown[], content = "A generated response.") {
  return {
    chat: {
      completions: {
        create: async (request: unknown) => {
          requests.push(request);
          return {
            choices: [{ message: { content } }],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 4,
              prompt_tokens_details: { cached_tokens: 1 }
            }
          };
        }
      }
    }
  };
}
