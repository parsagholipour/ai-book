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

  it("returns the deterministic fallback when AI planning validation fails", async () => {
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
      textModel: new FailingPlannerAdapter(),
      research: new FakeResearchAdapter()
    });

    expect(plan.title).toBe(makeFallbackPlan(input).title);
    expect(plan.premise).toBe(input.prompt);
    expect(plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(input.targetPages);
    expect(plan.researchNotes).toHaveLength(1);
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
