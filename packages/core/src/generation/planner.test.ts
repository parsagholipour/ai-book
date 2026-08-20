import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { GenerateJsonOptions, GenerateTextOptions, JsonResult, TextModelAdapter, TextResult } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { createPlanningPackage, ensurePlanStyleContract, normalizePlanPageTargets, revisePlanningPackage } from "./planner.js";

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
    // Premade answers are for questions a few complete answers really cover. A
    // name or a title is asked open, so the reader types it once instead of
    // tapping an option that only describes how they would answer.
    expect(systemPrompt).toContain("set options to [] and let them type it");
    expect(systemPrompt).toContain("Never write an option that only describes how the reader will answer");
    // The app draws the picker from answerKind, so a question several options
    // answer at once is declared rather than smuggled into the prompt text.
    expect(systemPrompt).toContain('"multi" (up to 6 options)');
    expect(systemPrompt).toContain("never list the options inside the prompt text");
  });

  it("keeps at most one subject clarification for an incomplete prompt", async () => {
    const input = testInput({ prompt: "Write a story" });
    const candidate: BookPlan = {
      ...makeFallbackPlan(input),
      questions: [
        { prompt: "What should the story be about?", options: ["A hero", "An animal"], answerKind: "choice", allowCustom: true },
        { prompt: "What mood should it have?", options: ["Cozy", "Funny"], answerKind: "choice", allowCustom: true }
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
    // A revision re-emits questions, so it carries the same open-answer rule.
    const revisionPrompt = request!.messages.find((message) => message.role === "system")!.content;
    expect(revisionPrompt).toContain("set options to [] and let them type it");
    expect(revisionPrompt).toContain('"multi" (up to 6 options)');
  });

  it("defaults omitted revision questions to none instead of restoring legacy questions", async () => {
    const input = testInput();
    const currentPlan: BookPlan = {
      ...makeFallbackPlan(input),
      questions: [
        { prompt: "What tone should the story have?", options: ["Playful", "Calm"], answerKind: "choice", allowCustom: true },
        { prompt: "Should the turtle have a name?", options: ["Yes", "No"], answerKind: "choice", allowCustom: true },
        { prompt: "How long should chapters be?", options: ["Short", "Long"], answerKind: "choice", allowCustom: true }
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
        { prompt: answeredPrompt, options: ["My notes"], answerKind: "open", allowCustom: true }
      ]
    };
    const textModel: TextModelAdapter = {
      async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
        return {
          data: {
            title: "Revised Rabbit Race",
            questions: [
              { prompt: answeredPrompt, options: ["My notes"], answerKind: "open", allowCustom: true },
              { prompt: necessaryPrompt, options: ["Keep four", "Use eight"], answerKind: "choice", allowCustom: true },
              { prompt: "What mood should it have?", options: ["Cozy"], answerKind: "open", allowCustom: true }
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

  it("keeps the book's style contract when the revision emits empty style arrays", async () => {
    const input = testInput();
    const currentPlan: BookPlan = {
      ...makeFallbackPlan(input),
      voiceGuide: ["Keep the fable dry and unhurried.", "Let the turtle's patience read as stubbornness."],
      antiAiRules: ["No moral-of-the-story closing line.", "Never call the race a journey.", "No sparkle words."]
    };
    const textModel: TextModelAdapter = {
      async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
        return {
          data: { title: "The Shorter Race", voiceGuide: [], antiAiRules: [] } as T,
          text: "{\"title\":\"The Shorter Race\",\"voiceGuide\":[],\"antiAiRules\":[]}",
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
      userMessage: "Make it shorter.",
      textModel,
      input,
      targetPages: input.targetPages
    });

    // An emitted `[]` is a field the model had nothing to say about, not a
    // request to delete the contract: "make it shorter" must not cost the book
    // its voice.
    expect(revised.title).toBe("The Shorter Race");
    expect(revised.voiceGuide).toEqual(currentPlan.voiceGuide);
    expect(revised.antiAiRules).toEqual(currentPlan.antiAiRules);
  });
});

describe("normalizePlanPageTargets", () => {
  const chapterAt = (index: number, targetPages = 1) => ({
    index,
    title: `Beat ${index}`,
    summary: `What happens in beat ${index}.`,
    targetPages,
    keyBeats: [`Beat ${index} happens.`]
  });

  it("merges a one-chapter-per-page plan for a book long enough to print chapters", () => {
    const base = makeFallbackPlan(testInput({ targetPages: 12 }));
    const plan = { ...base, chapters: Array.from({ length: 12 }, (_, offset) => chapterAt(offset + 1)) } as BookPlan;

    const normalized = normalizePlanPageTargets(plan, 12);

    // The prompt forbids one chapter per page; the old guard only fired when
    // chapters *exceeded* the page count, so exactly-one-per-page slipped by.
    expect(normalized.chapters.length).toBeLessThanOrEqual(6);
    expect(normalized.chapters.length).toBeGreaterThan(1);
    const total = normalized.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0);
    expect(total).toBe(12);
    // Merging is pairwise-adjacent, so no single chapter swallows the tail.
    expect(Math.max(...normalized.chapters.map((chapter) => chapter.targetPages))).toBeLessThanOrEqual(4);
    expect(normalized.chapters.map((chapter) => chapter.index)).toEqual(
      normalized.chapters.map((_, offset) => offset + 1)
    );
  });

  it("leaves a short book's one-page chapters alone — they are a writing scaffold", () => {
    const base = makeFallbackPlan(testInput({ targetPages: 3 }));
    const plan = { ...base, chapters: [chapterAt(1), chapterAt(2), chapterAt(3)] } as BookPlan;

    const normalized = normalizePlanPageTargets(plan, 3);

    expect(normalized.chapters).toHaveLength(3);
    expect(normalized.chapters.every((chapter) => chapter.targetPages === 1)).toBe(true);
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

describe("ensurePlanStyleContract", () => {
  it("returns a plan whose contract is already substantial by identity", () => {
    const plan = makeFallbackPlan(
      testInput({ prompt: "Write a practical field guide to observing suburban wildlife at dawn" })
    );

    expect(ensurePlanStyleContract(plan, { toneProfile: "neutral" })).toBe(plan);
  });

  it("appends the fallback composition under a vacuous contract, keeping the model's rules first", () => {
    const input = testInput({ prompt: "Write a practical field guide to observing suburban wildlife at dawn" });
    const plan: BookPlan = {
      ...makeFallbackPlan(input),
      voiceGuide: ["Write naturally"],
      antiAiRules: ["Write naturally"]
    };

    const ensured = ensurePlanStyleContract(plan, { input, toneProfile: "neutral" });

    expect(ensured.voiceGuide[0]).toBe("Write naturally");
    expect(ensured.voiceGuide.length).toBeGreaterThanOrEqual(2);
    expect(ensured.antiAiRules[0]).toBe("Write naturally");
    expect(ensured.antiAiRules.length).toBeGreaterThanOrEqual(3);
    // The tone guardrails travel even with no template supplied.
    expect(ensured.antiAiRules.join(" ")).toMatch(/em dashes/i);
  });

  it("restores the kids reading band a picture book's thin contract left out", () => {
    const input = testInput({
      prompt: "A simple picture book about a turtle and a rabbit learning to race kindly",
      category: "KIDS",
      complexity: 3,
      mediaSettings: { ...testInput().mediaSettings, audienceAgeRange: "4-6" }
    });
    const plan: BookPlan = { ...makeFallbackPlan(input), voiceGuide: ["Write naturally"] };

    const ensured = ensurePlanStyleContract(plan, { input, toneProfile: "neutral" });

    // The reading band is the half `makeFallbackPlan` composes from `input`, so
    // it is the half a contract rebuilt without one silently loses.
    expect(ensured.voiceGuide.join(" ")).toMatch(/20-65 words per page/i);
    expect(ensured.voiceGuide.join(" ")).toMatch(/picture-book vocabulary/i);
    expect(ensured.voiceGuide).toEqual(expect.arrayContaining(makeFallbackPlan(input).voiceGuide));
  });

  it("does not file the tone profile's label line as a style rule", () => {
    const input = testInput();
    const plan: BookPlan = { ...makeFallbackPlan(input), voiceGuide: ["Write naturally"] };

    const ensured = ensurePlanStyleContract(plan, { input, toneProfile: "neutral" });

    // "Tone profile: Neutral." names the profile for a prompt heading; nobody
    // can write to it, so it belongs to neither half of the contract.
    expect(ensured.voiceGuide.some((rule) => rule.startsWith("Tone profile:"))).toBe(false);
    expect(ensured.antiAiRules.some((rule) => rule.startsWith("Tone profile:"))).toBe(false);
    expect(makeFallbackPlan(input).voiceGuide.some((rule) => rule.startsWith("Tone profile:"))).toBe(false);
  });
});
