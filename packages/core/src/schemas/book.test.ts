import { describe, expect, it } from "vitest";
import { BOOK_CATEGORIES } from "../categories.js";
import { TONE_PROFILES, bookPlanSchema, bookPlanSchemaWithFallback, createProjectSchema } from "./book.js";

describe("createProjectSchema", () => {
  it("accepts the expanded top-level book categories", () => {
    for (const category of BOOK_CATEGORIES) {
      const input = createProjectSchema.parse({
        prompt: "A practical book with enough detail to pass prompt validation.",
        category
      });

      expect(input.category).toBe(category);
    }
  });

  it("accepts a General project with a popular subcategory", () => {
    const input = createProjectSchema.parse({
      prompt: "A practical book about how online communities shape neighborhood life.",
      category: "CUSTOM",
      subcategory: " Social / Society & culture "
    });

    expect(input.category).toBe("CUSTOM");
    expect(input.subcategory).toBe("Social / Society & culture");
  });

  it("treats a blank subcategory as omitted", () => {
    const input = createProjectSchema.parse({
      prompt: "A compact guide to planning a small local workshop.",
      category: "CUSTOM",
      subcategory: "   "
    });

    expect(input.subcategory).toBeUndefined();
  });

  it("rejects subcategories longer than eighty characters", () => {
    const result = createProjectSchema.safeParse({
      prompt: "A compact guide to planning a small local workshop.",
      category: "CUSTOM",
      subcategory: "x".repeat(81)
    });

    expect(result.success).toBe(false);
  });

  it("defaults missing tone profile to neutral and accepts every tone profile", () => {
    const defaulted = createProjectSchema.parse({
      prompt: "A practical book about making generated prose sound less synthetic."
    });
    expect(defaulted.mediaSettings.toneProfile).toBe("neutral");

    for (const toneProfile of TONE_PROFILES) {
      const input = createProjectSchema.parse({
        prompt: "A practical book about making generated prose sound less synthetic.",
        mediaSettings: {
          fullIllustrations: true,
          illustrationCadence: "template-driven",
          includeCover: true,
          coverTemplate: "auto",
          finalReview: true,
          lessCensored: false,
          toneProfile
        }
      });
      expect(input.mediaSettings.toneProfile).toBe(toneProfile);
    }
  });

  it("accepts a Kids audience age range in media settings", () => {
    const input = createProjectSchema.parse({
      prompt: "A simple picture book about a turtle and a rabbit learning to race kindly.",
      category: "KIDS",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        lessCensored: false,
        audienceAgeRange: "2-4",
        toneProfile: "neutral"
      }
    });

    expect(input.mediaSettings.audienceAgeRange).toBe("2-4");
  });

  it("rejects unsupported audience age ranges", () => {
    const result = createProjectSchema.safeParse({
      prompt: "A simple picture book about a turtle and a rabbit learning to race kindly.",
      category: "KIDS",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        lessCensored: false,
        audienceAgeRange: "5-7",
        toneProfile: "neutral"
      }
    });

    expect(result.success).toBe(false);
  });

  it("accepts an optional selected text model in media settings", () => {
    const input = createProjectSchema.parse({
      prompt: "A practical book about choosing an AI model for planning and drafting.",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        lessCensored: false,
        generationStrategy: "chaptered-sequential",
        textModel: {
          provider: "gemini",
          model: "gemini-3.5-flash"
        },
        toneProfile: "neutral"
      }
    });

    expect(input.mediaSettings.textModel).toEqual({ provider: "gemini", model: "gemini-3.5-flash" });
  });

  it("accepts a Gemini no-thinking text model variant in media settings", () => {
    const input = createProjectSchema.parse({
      prompt: "A practical book about choosing an AI model for planning and drafting.",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        lessCensored: false,
        generationStrategy: "chaptered-sequential",
        textModel: {
          provider: "gemini",
          model: "gemini-2.5-flash",
          thinkingBudget: 0
        },
        toneProfile: "neutral"
      }
    });

    expect(input.mediaSettings.textModel).toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
      thinkingBudget: 0
    });
  });

  it("accepts a DeepSeek thinking text model variant in media settings", () => {
    const input = createProjectSchema.parse({
      prompt: "A practical book about choosing an AI model for planning and drafting.",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        lessCensored: false,
        generationStrategy: "chaptered-sequential",
        textModel: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          thinkingEnabled: true
        },
        toneProfile: "neutral"
      }
    });

    expect(input.mediaSettings.textModel).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinkingEnabled: true
    });
  });

  it("accepts a DeepInfra thinking text model variant in media settings", () => {
    const input = createProjectSchema.parse({
      prompt: "A practical book about choosing an AI model for planning and drafting.",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        lessCensored: false,
        generationStrategy: "chaptered-sequential",
        textModel: {
          provider: "deepinfra",
          model: "deepseek-ai/DeepSeek-V4-Pro",
          thinkingEnabled: true
        },
        toneProfile: "neutral"
      }
    });

    expect(input.mediaSettings.textModel).toEqual({
      provider: "deepinfra",
      model: "deepseek-ai/DeepSeek-V4-Pro",
      thinkingEnabled: true
    });
  });

  it("accepts Alibaba Qwen text models in media settings", () => {
    const input = createProjectSchema.parse({
      prompt: "A practical book about choosing an AI model for planning and drafting.",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        lessCensored: false,
        generationStrategy: "chaptered-sequential",
        textModel: {
          provider: "alibaba",
          model: "qwen-plus"
        },
        toneProfile: "neutral"
      }
    });

    expect(input.mediaSettings.textModel).toEqual({ provider: "alibaba", model: "qwen-plus" });
  });

  it("accepts and normalizes an optional selected image model in media settings", () => {
    const defaulted = createProjectSchema.parse({
      prompt: "A practical book about choosing an AI model for image generation."
    });
    const legacyInput = createProjectSchema.parse({
      prompt: "A practical book about choosing an AI model for image generation.",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        lessCensored: false,
        imageModel: "models/imagen-4.0-fast-generate-preview-06-06",
        toneProfile: "neutral"
      }
    });
    const qwenInput = createProjectSchema.parse({
      prompt: "A practical book about choosing an AI model for image generation.",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        lessCensored: false,
        imageModel: { provider: "alibaba", model: "models/qwen-image-2.0" },
        toneProfile: "neutral"
      }
    });

    expect(defaulted.mediaSettings.imageModel).toBeUndefined();
    expect(legacyInput.mediaSettings.imageModel).toEqual({
      provider: "gemini",
      model: "imagen-4.0-fast-generate-001"
    });
    expect(qwenInput.mediaSettings.imageModel).toEqual({ provider: "alibaba", model: "qwen-image-2.0" });
  });

  it("normalizes model-style illustration cadence aliases", () => {
    const chapterBased = bookPlanSchema.parse(minimalPlan("chapter-based"));
    const eachPage = bookPlanSchema.parse(minimalPlan("each page"));
    const unfamiliar = bookPlanSchema.parse(minimalPlan("illustrate key moments"));

    expect(chapterBased.illustrationPlan.cadence).toBe("template-driven");
    expect(eachPage.illustrationPlan.cadence).toBe("every-page");
    expect(unfamiliar.illustrationPlan.cadence).toBe("template-driven");
  });

  it("accepts planner complexity aliases from copied project input", () => {
    const { writingComplexity: _writingComplexity, ...planWithoutWritingComplexity } = minimalPlan("template-driven");
    const plan = bookPlanSchema.parse({
      ...planWithoutWritingComplexity,
      authorName: "Ada Editor",
      category: "SCIENCE",
      targetPages: 1,
      complexity: "6",
      temperature: 0.4,
      language: "en",
      mediaSettings: {
        illustrationCadence: "template-driven"
      }
    });

    expect(plan.writingComplexity).toBe(6);
  });

  it("recovers a partial plan from an echoed planning prompt envelope", () => {
    const fallbackOutline = minimalPlan("template-driven");
    const plan = bookPlanSchema.parse({
      userInput: {
        prompt: fallbackOutline.premise,
        category: "SCIENCE",
        targetPages: 1,
        complexity: 6
      },
      toneProfile: "neutral",
      template: {
        slug: "science-book"
      },
      fallbackOutline,
      researchNotes: [],
      plan: {
        title: "Cooler Cities",
        writingComplexity: 7,
        voiceGuide: ["Concrete, field-tested, and calm."],
        antiAiRules: ["Avoid generic climate-book phrasing."],
        chapters: fallbackOutline.chapters,
        illustrationPlan: fallbackOutline.illustrationPlan
      }
    });

    expect(plan.title).toBe("Cooler Cities");
    expect(plan.premise).toBe(fallbackOutline.premise);
    expect(plan.audience).toBe(fallbackOutline.audience);
    expect(plan.writingComplexity).toBe(7);
  });

  it("recovers provider plans nested under generationPlan without losing visual detail", () => {
    const fallbackOutline = bookPlanSchema.parse(minimalPlan("template-driven"));
    const plan = bookPlanSchemaWithFallback(fallbackOutline).parse({
      title: "Cooler Cities",
      subtitle: "Field Notes for Heat",
      generationPlan: {
        pageCount: 2,
        chapters: [
          {
            index: 1,
            title: "Shade First",
            summary: "Turns the book toward street-level shade choices.",
            targetPages: 2,
            keyBeats: ["Open with a bus stop heat problem."],
            illustrationPrompts: ["A bus stop split between harsh sun and dense tree shade."]
          }
        ],
        voiceGuide: "Calm, exact, and source-aware.",
        antiAiRules: "Avoid generic climate-book phrasing.",
        characters: [],
        locations: [],
        continuityRules: ["Keep city examples concrete."],
        illustrationPlan: {
          cadence: "template-driven",
          globalStyle: "Editorial civic diagrams",
          characterReferencePrompts: [],
          pageRules: ["Use readable urban scenes."]
        }
      },
      questions: ["Should the book focus on homeowners or city staff?"]
    });

    expect(plan.title).toBe("Cooler Cities");
    expect(plan.subtitle).toBe("Field Notes for Heat");
    expect(plan.premise).toBe(fallbackOutline.premise);
    expect(plan.audience).toBe(fallbackOutline.audience);
    expect(plan.voiceGuide).toEqual(["Calm, exact, and source-aware."]);
    expect(plan.antiAiRules).toEqual(["Avoid generic climate-book phrasing."]);
    expect(plan.questions[0]?.prompt).toBe("Should the book focus on homeowners or city staff?");
    expect(plan.chapters[0]?.title).toBe("Shade First");
    expect(plan.chapters[0]?.illustrationPrompts).toEqual([
      "A bus stop split between harsh sun and dense tree shade."
    ]);
  });

  it("repairs planner characters that omit role", () => {
    const plan = bookPlanSchema.parse({
      ...minimalPlan("template-driven"),
      characters: [
        {
          name: "Nora",
          description: "The child who notices the first impossible pattern.",
          traits: ["observant"],
          visualRules: ["Round glasses."]
        },
        {
          name: "The Clockmaker",
          archetype: "Mentor",
          bio: "A careful guide who understands the town's old machines.",
          appearance: "Silver hair and ink-stained cuffs."
        }
      ]
    });

    expect(plan.characters[0]?.role).toBe("Supporting character");
    expect(plan.characters[1]?.role).toBe("Mentor");
    expect(plan.characters[1]?.description).toBe("A careful guide who understands the town's old machines.");
    expect(plan.characters[1]?.visualRules).toEqual(["Silver hair and ink-stained cuffs."]);
  });
});

function minimalPlan(cadence: string) {
  return {
    title: "Heat Cities",
    premise: "A practical science book about cities adapting to extreme heat.",
    audience: "Curious adult readers",
    writingComplexity: 6,
    voiceGuide: ["Clear, concrete, and editorial."],
    antiAiRules: ["Avoid boilerplate transitions."],
    chapters: [
      {
        index: 1,
        title: "The Heat We Can Feel",
        summary: "Introduce the stakes.",
        targetPages: 1,
        keyBeats: ["Open with a concrete urban heat example."]
      }
    ],
    illustrationPlan: {
      cadence,
      globalStyle: "Editorial science illustration",
      characterReferencePrompts: [],
      pageRules: []
    }
  };
}
