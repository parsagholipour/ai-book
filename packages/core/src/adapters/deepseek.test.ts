import { describe, expect, it } from "vitest";
import { DeepSeekAdapter, parseJsonObject } from "./deepseek.js";

describe("DeepSeekAdapter", () => {
  it("sends the configured thinking mode to text requests", async () => {
    const enabledRequests: any[] = [];
    const maxEffortRequests: any[] = [];
    const disabledRequests: any[] = [];
    const thinkingAdapter = new DeepSeekAdapter({
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      thinkingEnabled: true
    });
    const maxEffortAdapter = new DeepSeekAdapter({
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      thinkingEffort: "max"
    });
    const defaultAdapter = new DeepSeekAdapter({ apiKey: "test-key", model: "deepseek-v4-pro" });
    (thinkingAdapter as any).client = mockOpenAiClient(enabledRequests);
    (maxEffortAdapter as any).client = mockOpenAiClient(maxEffortRequests);
    (defaultAdapter as any).client = mockOpenAiClient(disabledRequests);

    await thinkingAdapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });
    await maxEffortAdapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });
    await defaultAdapter.generateText({ messages: [{ role: "user", content: "Draft a paragraph." }] });

    expect(enabledRequests[0].thinking).toEqual({ type: "enabled" });
    expect(enabledRequests[0].reasoning_effort).toBe("high");
    expect(maxEffortRequests[0]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max"
    });
    expect(disabledRequests[0].thinking).toEqual({ type: "disabled" });
    expect(disabledRequests[0]).not.toHaveProperty("reasoning_effort");
  });
});

describe("DeepSeek JSON parsing", () => {
  it("repairs missing commas between array objects", () => {
    const parsed = parseJsonObject(`{
      "pages": [
        { "pageIndex": 1, "beat": "Open the argument." }
        { "pageIndex": 2, "beat": "Advance the argument." }
      ]
    }`) as { pages: Array<{ pageIndex: number }> };

    expect(parsed.pages.map((page) => page.pageIndex)).toEqual([1, 2]);
  });

  it("accepts fenced JSON with trailing commas", () => {
    const parsed = parseJsonObject(`\`\`\`json
    {
      "approved": true,
      "issues": [],
    }
    \`\`\``) as { approved: boolean; issues: string[] };

    expect(parsed).toEqual({ approved: true, issues: [] });
  });

  it("repairs unquoted object property names", () => {
    const parsed = parseJsonObject(`{
      "approved": true,
      "score": 88,
      "issues": [],
      "requiredRevisions": [],
      "notes": "The page is specific and progressive.",
      "checks": {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    }`) as { checks: { promptLeakFree: boolean; progressionOk: boolean } };

    expect(parsed.checks).toMatchObject({
      promptLeakFree: true,
      progressionOk: true
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
            usage: { prompt_tokens: 3, completion_tokens: 4 }
          };
        }
      }
    }
  };
}
