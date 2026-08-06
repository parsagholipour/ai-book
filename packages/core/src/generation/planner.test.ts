import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { GenerateJsonOptions, GenerateTextOptions, JsonResult, TextModelAdapter, TextResult } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { createPlanningPackage, revisePlanningPackage } from "./planner.js";

describe("createPlanningPackage", () => {
  it("reports real planning phases around research and generation", async () => {
    const events: string[] = [];
    const input = testInput({
      prompt: "Write a current scientific guide to rabbit and turtle movement"
    });
    const fallback = makeFallbackPlan(input);
    const textModel: TextModelAdapter = {
      async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
        events.push("generate");
        return {
          data: fallback as T,
          text: JSON.stringify(fallback),
          model: "test-model",
          provider: "test"
        };
      },
      async generateText(_options: GenerateTextOptions): Promise<TextResult> {
        throw new Error("Not used");
      },
      async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
        throw new Error("Not used");
      },
      generateWithTools: unsupportedGenerateWithTools
    };

    await createPlanningPackage({
      input,
      textModel,
      research: {
        async search(query) {
          events.push(`research:${query.query}`);
          return { query: query.query, summary: "", sources: [] };
        }
      },
      onPhase: (phase) => {
        events.push(`phase:${phase}`);
      }
    });

    expect(events[0]).toBe("phase:understand");
    expect(events.filter((event) => event.startsWith("research:")).length).toBeGreaterThan(0);
    const lastResearchIndex = events.reduce(
      (lastIndex, event, index) => event.startsWith("research:") ? index : lastIndex,
      -1
    );
    expect(events.indexOf("phase:shape")).toBeGreaterThan(lastResearchIndex);
    expect(events.indexOf("phase:shape")).toBeLessThan(events.indexOf("generate"));
    expect(events.at(-1)).toBe("phase:finalize");
  });

  it("reports shaping and finalization for fallback plans", async () => {
    const phases: string[] = [];

    await createPlanningPackage({
      input: testInput(),
      textModel: unusedTextModel(),
      research: {
        async search(query) {
          return { query: query.query, summary: "", sources: [] };
        }
      },
      forceFallback: true,
      onPhase: (phase) => {
        phases.push(phase);
      }
    });

    expect(phases).toEqual(["understand", "shape", "finalize"]);
  });

  it("keeps planning research out of the model response and attaches trusted sources server-side", async () => {
    const input = testInput({ prompt: "Write a current guide to household energy use" });
    const fallback = makeFallbackPlan(input);
    let request: GenerateJsonOptions<unknown> | undefined;
    const textModel: TextModelAdapter = {
      async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
        request = options as GenerateJsonOptions<unknown>;
        const modelResponse = {
          ...fallback,
          researchNotes: [
            {
              query: "model-created-query",
              title: "Model-created source",
              summary: "This source was invented by the model."
            }
          ]
        };
        return {
          data: options.schema.parse(modelResponse),
          text: JSON.stringify(modelResponse),
          model: "test-model",
          provider: "test"
        };
      },
      async generateText(_options: GenerateTextOptions): Promise<TextResult> {
        throw new Error("Not used");
      },
      async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
        throw new Error("Not used");
      },
      generateWithTools: unsupportedGenerateWithTools
    };

    const plan = await createPlanningPackage({
      input,
      textModel,
      research: {
        async search(query) {
          return {
            query: query.query,
            summary: "Trusted research summary",
            sources: [
              {
                title: "Trusted source one",
                url: "https://example.com/one",
                summary: "First trusted finding."
              },
              {
                title: "Trusted source two",
                url: "https://example.com/two",
                summary: "Second trusted finding."
              }
            ]
          };
        }
      }
    });

    expect(plan.researchNotes).toEqual([
      {
        query: input.prompt,
        title: "Trusted source one",
        url: "https://example.com/one",
        summary: "First trusted finding."
      },
      {
        query: input.prompt,
        title: "Trusted source two",
        url: "https://example.com/two",
        summary: "Second trusted finding."
      }
    ]);
    expect(
      (
        request!.schema.parse({
          ...fallback,
          researchNotes: [{ query: "x", title: "x", summary: "x" }]
        }) as Record<string, unknown>
      ).researchNotes
    ).toBeUndefined();
    const systemPrompt = request!.messages.find((message) => message.role === "system")!.content;
    expect(systemPrompt).toContain("do not include a researchNotes field");
    const userPayload = JSON.parse(request!.messages.find((message) => message.role === "user")!.content);
    expect(userPayload.researchNotes).toBeUndefined();
    expect(userPayload.fallbackOutline.researchNotes).toBeUndefined();
    expect(userPayload.researchContext).toEqual([
      {
        query: input.prompt,
        sources: [
          {
            title: "Trusted source one",
            url: "https://example.com/one",
            summary: "First trusted finding."
          },
          {
            title: "Trusted source two",
            url: "https://example.com/two",
            summary: "Second trusted finding."
          }
        ]
      }
    ]);
    expect(JSON.stringify(userPayload.researchContext).split(input.prompt)).toHaveLength(2);
  });

  it("preserves the model's empty clarification decision for a clear prompt", async () => {
    const input = testInput({
      prompt: "A bedtime story for a 5-year-old about Spider-Man in Brazil"
    });
    const candidate: BookPlan = {
      ...makeFallbackPlan(input),
      questions: []
    };
    let systemPrompt = "";
    const textModel: TextModelAdapter = {
      async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
        systemPrompt = options.messages.find((message) => message.role === "system")?.content ?? "";
        return {
          data: candidate as T,
          text: JSON.stringify(candidate),
          model: "test-model",
          provider: "test"
        };
      },
      async generateText(_options: GenerateTextOptions): Promise<TextResult> {
        throw new Error("Not used");
      },
      async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
        throw new Error("Not used");
      },
      generateWithTools: unsupportedGenerateWithTools
    };

    const plan = await createPlanningPackage({
      input,
      textModel,
      research: { async search(query) { return { query: query.query, summary: "", sources: [] }; } }
    });

    expect(plan.questions).toEqual([]);
    expect(systemPrompt).toContain("Set questions to [] for every coherent request");
    expect(systemPrompt).toContain("Never ask for optional tone, mood, conflict, ending");
  });

  it("keeps at most one subject clarification for an incomplete prompt", async () => {
    const input = testInput({ prompt: "Write a story" });
    const candidate: BookPlan = {
      ...makeFallbackPlan(input),
      questions: [
        { prompt: "What should the story be about?", options: ["A hero", "An animal"], allowCustom: true },
        { prompt: "What mood should it have?", options: ["Cozy", "Funny"], allowCustom: true }
      ]
    };
    const textModel: TextModelAdapter = {
      async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
        return {
          data: candidate as T,
          text: JSON.stringify(candidate),
          model: "test-model",
          provider: "test"
        };
      },
      async generateText(_options: GenerateTextOptions): Promise<TextResult> {
        throw new Error("Not used");
      },
      async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
        throw new Error("Not used");
      },
      generateWithTools: unsupportedGenerateWithTools
    };

    const plan = await createPlanningPackage({
      input,
      textModel,
      research: { async search(query) { return { query: query.query, summary: "", sources: [] }; } }
    });

    expect(plan.questions.map((question) => question.prompt)).toEqual(["What should the story be about?"]);
  });
});

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
      },
      generateWithTools: unsupportedGenerateWithTools
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

  it("defaults omitted revision questions to none instead of restoring legacy questions", async () => {
    const input = testInput();
    const currentPlan: BookPlan = {
      ...makeFallbackPlan(input),
      questions: [
        { prompt: "What tone should the story have?", options: ["Playful", "Calm"], allowCustom: true },
        { prompt: "Should the turtle have a name?", options: ["Yes", "No"], allowCustom: true },
        { prompt: "How long should chapters be?", options: ["Short", "Long"], allowCustom: true }
      ]
    };
    const textModel: TextModelAdapter = {
      async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
        return {
          data: { title: "Revised Rabbit Race" } as T,
          text: "{\"title\":\"Revised Rabbit Race\"}",
          model: "test-model",
          provider: "test"
        };
      },
      async generateText(_options: GenerateTextOptions): Promise<TextResult> {
        throw new Error("Not used");
      },
      async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
        throw new Error("Not used");
      },
      generateWithTools: unsupportedGenerateWithTools
    };

    const revised = await revisePlanningPackage({
      currentPlan,
      userMessage:
        "Planning question responses:\n1. What tone should the story have?\nAnswer: Playful\nSkipped questions with no preference:\n- Should the turtle have a name?",
      textModel,
      input,
      targetPages: input.targetPages,
      respondedQuestionPrompts: ["What tone should the story have?", "Should the turtle have a name?"]
    });

    expect(revised.questions).toEqual([]);
  });

  it("removes responded questions and keeps only the model's highest-priority remainder", async () => {
    const input = testInput();
    const answeredPrompt = "Which source should the revision use?";
    const necessaryPrompt = "The instructions conflict. Should the race remain four pages?";
    const currentPlan: BookPlan = {
      ...makeFallbackPlan(input),
      questions: [
        { prompt: answeredPrompt, options: ["My notes"], allowCustom: true }
      ]
    };
    const textModel: TextModelAdapter = {
      async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
        return {
          data: {
            title: "Revised Rabbit Race",
            questions: [
              { prompt: answeredPrompt, options: ["My notes"], allowCustom: true },
              { prompt: necessaryPrompt, options: ["Keep four", "Use eight"], allowCustom: true },
              { prompt: "What mood should it have?", options: ["Cozy"], allowCustom: true }
            ]
          } as T,
          text: "{}",
          model: "test-model",
          provider: "test"
        };
      },
      async generateText(_options: GenerateTextOptions): Promise<TextResult> {
        throw new Error("Not used");
      },
      async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
        throw new Error("Not used");
      },
      generateWithTools: unsupportedGenerateWithTools
    };

    const revised = await revisePlanningPackage({
      currentPlan,
      userMessage: "Use my notes, but keep the conflicting page-count instructions for me to resolve.",
      textModel,
      input,
      targetPages: input.targetPages,
      respondedQuestionPrompts: [answeredPrompt]
    });

    expect(revised.questions.map((question) => question.prompt)).toEqual([necessaryPrompt]);
  });
});

function testInput(overrides: Partial<CreateProjectInput> = {}): CreateProjectInput {
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
    },
    ...overrides
  };
}

function unusedTextModel(): TextModelAdapter {
  return {
    async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
      throw new Error("Not used");
    },
    async generateText(_options: GenerateTextOptions): Promise<TextResult> {
      throw new Error("Not used");
    },
    async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
      throw new Error("Not used");
    },
    generateWithTools: unsupportedGenerateWithTools
  };
}
