import { describe, expect, it } from "vitest";
import {
  FakeResearchAdapter,
  FakeTextModelAdapter,
  makeFallbackPlan,
  createPlanningPackage,
  revisePlanningPackage,
  type CreateProjectInput,
  type GenerateJsonOptions,
  type TextModelAdapter
} from "../index.js";

describe("deterministic dry run", () => {
  it("creates a 320-page-capable fallback plan without provider calls", async () => {
    const input = {
      prompt: "A practical science book about cities adapting to extreme heat.",
      category: "SCIENCE" as const,
      targetPages: 320,
      complexity: 6,
      temperature: 0.4,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven" as const,
        includeCover: true,
        coverTemplate: "auto" as const,
        finalReview: true,
        lessCensored: false,
        toneProfile: "neutral" as const
      }
    };

    const fallback = makeFallbackPlan(input);
    const plan = await createPlanningPackage({
      input,
      textModel: new FakeTextModelAdapter(input),
      research: new FakeResearchAdapter(),
      forceFallback: true
    });

    expect(plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(320);
    expect(fallback.illustrationPlan.cadence).toBe("template-driven");
  });

  it("fails loudly when AI planning validation cannot be recovered", async () => {
    const input = {
      prompt: "A practical science book about cities adapting to extreme heat.",
      category: "SCIENCE" as const,
      targetPages: 320,
      complexity: 6,
      temperature: 0.4,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven" as const,
        includeCover: true,
        coverTemplate: "auto" as const,
        finalReview: true,
        lessCensored: false,
        toneProfile: "neutral" as const
      }
    };

    await expect(
      createPlanningPackage({
        input,
        textModel: new FailingPlannerAdapter(),
        research: new FakeResearchAdapter()
      })
    ).rejects.toThrow("AI planner failed. No fallback plan was created.");
  });

  it("accepts provider JSON wrapped in a plan root key", async () => {
    const input = {
      prompt: "A practical science book about cities adapting to extreme heat.",
      category: "SCIENCE" as const,
      targetPages: 320,
      complexity: 6,
      temperature: 0.4,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven" as const,
        includeCover: true,
        coverTemplate: "auto" as const,
        finalReview: true,
        lessCensored: false,
        toneProfile: "neutral" as const
      }
    };

    const plan = await createPlanningPackage({
      input,
      textModel: new WrappedPlannerAdapter(input),
      research: new FakeResearchAdapter()
    });

    expect(plan.title).toBe(makeFallbackPlan(input).title);
    expect(plan.researchNotes).toHaveLength(1);
  });

  it("recovers specific provider plans nested under generationPlan", async () => {
    const input = smallBookInput();

    const plan = await createPlanningPackage({
      input,
      textModel: new GenerationPlanPlannerAdapter(),
      research: new FakeResearchAdapter()
    });

    expect(plan.title).toBe("Household Power");
    expect(plan.premise).toBe(input.prompt);
    expect(plan.chapters.map((chapter) => chapter.title)).toEqual(["Rituals as Infrastructure", "The Room Learns"]);
    expect(plan.chapters[0]?.illustrationPrompts).toEqual(["A kitchen table arranged like a quiet command center."]);
    expect(plan.voiceGuide).toEqual(["Measured, practical, and precise."]);
    expect(plan.questions[0]?.prompt).toBe("Should examples be domestic or workplace-focused?");
    expect(plan.researchNotes).toHaveLength(0);
  });

  it("normalizes planner research notes returned as strings", async () => {
    const input = smallBookInput();

    const plan = await createPlanningPackage({
      input,
      textModel: new StringResearchNotesPlannerAdapter(input),
      research: new FakeResearchAdapter()
    });

    expect(plan.researchNotes).toEqual([
      {
        query: "planner-note",
        title: "Planner research note",
        summary: "Use standard textbook-level concepts; do not invent studies."
      },
      {
        query: "planner-note",
        title: "Planner research note",
        summary: "Historical examples should be qualified when source detail is unavailable."
      }
    ]);
  });

  it("normalizes AI-created chapter page targets to the requested book length", async () => {
    const input = smallBookInput();

    const plan = await createPlanningPackage({
      input,
      textModel: new MismatchedPlannerAdapter(input),
      research: new FakeResearchAdapter()
    });

    expect(plan.chapters).toHaveLength(7);
    expect(plan.chapters.map((chapter) => chapter.targetPages)).toEqual([2, 2, 2, 1, 1, 1, 1]);
    expect(plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(input.targetPages);
  });

  it("normalizes revised chapter page targets to the requested book length", async () => {
    const input = smallBookInput();

    const plan = await revisePlanningPackage({
      currentPlan: makeFallbackPlan(input),
      userMessage: "Split this into the stronger seven-part outline.",
      textModel: new MismatchedPlannerAdapter(input),
      targetPages: input.targetPages
    });

    expect(plan.chapters.map((chapter) => chapter.targetPages)).toEqual([2, 2, 2, 1, 1, 1, 1]);
    expect(plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(input.targetPages);
  });

  it("recovers partial plan revisions by preserving the current plan", async () => {
    const input = smallBookInput();
    const currentPlan = makeFallbackPlan(input);

    const revised = await revisePlanningPackage({
      currentPlan,
      userMessage: "Retitle this and sharpen the premise.",
      textModel: new PartialRevisionPlannerAdapter(),
      targetPages: input.targetPages
    });

    expect(revised.title).toBe("Household Power, Retitled");
    expect(revised.subtitle).toBe("A sharper frame");
    expect(revised.premise).toBe("A revised premise that keeps the same book structure.");
    expect(revised.audience).toBe(currentPlan.audience);
    expect(revised.voiceGuide).toEqual(currentPlan.voiceGuide);
    expect(revised.chapters.map((chapter) => chapter.title)).toEqual(currentPlan.chapters.map((chapter) => chapter.title));
  });

  it("fails plan revision instead of creating a revision-note fallback", async () => {
    const input = {
      prompt: "A practical science book about cities adapting to extreme heat.",
      category: "SCIENCE" as const,
      targetPages: 320,
      complexity: 6,
      temperature: 0.4,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven" as const,
        includeCover: true,
        coverTemplate: "auto" as const,
        finalReview: true,
        lessCensored: false,
        toneProfile: "neutral" as const
      }
    };

    await expect(
      revisePlanningPackage({
        currentPlan: makeFallbackPlan(input),
        userMessage: "Make chapter two more practical.",
        textModel: new FailingPlannerAdapter()
      })
    ).rejects.toThrow("AI plan revision failed. No revised plan was created.");
  });
});

class FailingPlannerAdapter implements TextModelAdapter {
  async generateText() {
    return {
      text: "",
      model: "failing-model",
      provider: "test"
    };
  }

  async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<never> {
    throw new Error("schema validation failed");
  }

  async *streamText(): AsyncGenerator<string> {
    yield "";
  }
}

class MismatchedPlannerAdapter implements TextModelAdapter {
  constructor(private readonly input: CreateProjectInput) {}

  async generateText() {
    return {
      text: "",
      model: "mismatched-model",
      provider: "test"
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const plan = makeFallbackPlan(this.input);
    const mismatched = {
      ...plan,
      chapters: Array.from({ length: 7 }, (_, index) => ({
        index: index + 1,
        title: `Chapter ${index + 1}`,
        summary: `Movement ${index + 1}.`,
        targetPages: 2,
        keyBeats: [`Beat ${index + 1}`]
      }))
    };
    return {
      data: options.schema.parse(mismatched),
      text: JSON.stringify(mismatched),
      model: "mismatched-model",
      provider: "test"
    };
  }

  async *streamText(): AsyncGenerator<string> {
    yield "";
  }
}

class WrappedPlannerAdapter implements TextModelAdapter {
  constructor(private readonly input: CreateProjectInput) {}

  async generateText() {
    return {
      text: "",
      model: "wrapped-model",
      provider: "test"
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const plan = makeFallbackPlan(this.input);
    const wrapped = { plan };
    return {
      data: options.schema.parse(wrapped),
      text: JSON.stringify(wrapped),
      model: "wrapped-model",
      provider: "test"
    };
  }

  async *streamText(): AsyncGenerator<string> {
    yield "";
  }
}

class GenerationPlanPlannerAdapter implements TextModelAdapter {
  async generateText() {
    return {
      text: "",
      model: "generation-plan-model",
      provider: "test"
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const raw = {
      title: "Household Power",
      generationPlan: {
        chapters: [
          {
            index: 1,
            title: "Rituals as Infrastructure",
            summary: "Shows how repeated domestic practices allocate attention and authority.",
            targetPages: 5,
            keyBeats: ["Open with a table being reset after an argument."],
            illustrationPrompts: ["A kitchen table arranged like a quiet command center."]
          },
          {
            index: 2,
            title: "The Room Learns",
            summary: "Connects repeated spatial cues to shared expectations.",
            targetPages: 5,
            keyBeats: ["Move from object placement to negotiated routine."]
          }
        ],
        voiceGuide: "Measured, practical, and precise.",
        antiAiRules: ["Avoid vague power-language."],
        characters: [],
        locations: [],
        continuityRules: ["Keep examples concrete."],
        illustrationPlan: {
          cadence: "template-driven",
          globalStyle: "Editorial domestic still life",
          characterReferencePrompts: [],
          pageRules: ["Use objects and rooms as the visual anchor."]
        }
      },
      questions: ["Should examples be domestic or workplace-focused?"]
    };
    return {
      data: options.schema.parse(raw),
      text: JSON.stringify(raw),
      model: "generation-plan-model",
      provider: "test"
    };
  }

  async *streamText(): AsyncGenerator<string> {
    yield "";
  }
}

class StringResearchNotesPlannerAdapter implements TextModelAdapter {
  constructor(private readonly input: CreateProjectInput) {}

  async generateText() {
    return {
      text: "",
      model: "string-research-notes-model",
      provider: "test"
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const raw = {
      ...makeFallbackPlan(this.input),
      researchNotes: [
        "Use standard textbook-level concepts; do not invent studies.",
        "Historical examples should be qualified when source detail is unavailable."
      ]
    };
    return {
      data: options.schema.parse(raw),
      text: JSON.stringify(raw),
      model: "string-research-notes-model",
      provider: "test"
    };
  }

  async *streamText(): AsyncGenerator<string> {
    yield "";
  }
}

class PartialRevisionPlannerAdapter implements TextModelAdapter {
  async generateText() {
    return {
      text: "",
      model: "partial-revision-model",
      provider: "test"
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const raw = {
      title: "Household Power, Retitled",
      subtitle: "A sharper frame",
      premise: "A revised premise that keeps the same book structure."
    };
    return {
      data: options.schema.parse(raw),
      text: JSON.stringify(raw),
      model: "partial-revision-model",
      provider: "test"
    };
  }

  async *streamText(): AsyncGenerator<string> {
    yield "";
  }
}

function smallBookInput(): CreateProjectInput {
  return {
    prompt: "A concise research-grounded book about practical household rituals and power.",
    category: "CUSTOM",
    targetPages: 10,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      lessCensored: false,
      toneProfile: "neutral" as const
    }
  };
}
