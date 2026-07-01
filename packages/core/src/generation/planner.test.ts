import { describe, expect, it } from "vitest";
import type { GenerateJsonOptions, GenerateTextOptions, JsonResult, TextModelAdapter, TextResult } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { revisePlanningPackage } from "./planner.js";

describe("revisePlanningPackage", () => {
  it("uses a compact prompt and preserves existing research notes when omitted by the model", async () => {
    const input = testInput();
    const currentPlan: BookPlan = {
      ...makeFallbackPlan(input),
      researchNotes: [
        {
          query: "rabbit turtle fable",
          title: "Large source",
          url: "https://example.com/very-long-source",
          summary: "A".repeat(1200),
          publishedAt: "2026-01-01"
        }
      ]
    };
    let request: GenerateJsonOptions<unknown> | undefined;
    const textModel: TextModelAdapter = {
      async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
        request = options as GenerateJsonOptions<unknown>;
        return {
          data: {
            title: "Revised Rabbit Race",
            questions: []
          } as T,
          text: "{\"title\":\"Revised Rabbit Race\",\"questions\":[]}",
          model: "test-model",
          provider: "test"
        };
      },
      async generateText(_options: GenerateTextOptions): Promise<TextResult> {
        throw new Error("Not used");
      },
      async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
        throw new Error("Not used");
      }
    };

    const revised = await revisePlanningPackage({
      currentPlan,
      userMessage: "Use bold colors and remove the remaining questions.",
      textModel,
      input,
      targetPages: input.targetPages
    });

    expect(revised.title).toBe("Revised Rabbit Race");
    expect(revised.researchNotes).toEqual(currentPlan.researchNotes);
    expect(request?.purpose).toBe("revise-plan");
    const userPayload = JSON.parse(request!.messages.find((message) => message.role === "user")!.content);
    expect(userPayload.currentPlan.researchNotes).toBeUndefined();
    expect(userPayload.currentPlan.researchNoteCount).toBe(1);
    expect(userPayload.currentPlan.researchNotesSummary[0]).toMatchObject({
      query: "rabbit turtle fable",
      title: "Large source",
      publishedAt: "2026-01-01"
    });
    expect(userPayload.currentPlan.researchNotesSummary[0].url).toBeUndefined();
    expect(JSON.stringify(userPayload)).not.toContain("https://example.com/very-long-source");
    expect(JSON.stringify(userPayload)).not.toContain("A".repeat(300));
  });
});

function testInput(): CreateProjectInput {
  return {
    prompt: "Make a 4 page book of rabbit and turtle race",
    category: "STORY",
    targetPages: 4,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  };
}
