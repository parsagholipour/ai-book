import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { GenerateJsonOptions, GenerateTextOptions, JsonResult, TextModelAdapter, TextResult } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { critiquePlan, mergePlanCriticPatch } from "./planCritic.js";
import { rewriteRepetitiveStyleInstruction } from "./styleContract.js";

function samplePlan() {
  return makeFallbackPlan({
    prompt: "A story about a lantern and a river crossing.",
    category: "STORY",
    targetPages: 24,
    complexity: 5,
    temperature: 0.5,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "narrative"
    }
  });
}

function planWithChapters(chapters: Array<{ title: string; targetPages: number }>) {
  const plan = samplePlan();
  return {
    ...plan,
    chapters: chapters.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title,
      summary: `${chapter.title} holds this movement.`,
      targetPages: chapter.targetPages,
      keyBeats: [`${chapter.title} beat.`]
    }))
  };
}

describe("mergePlanCriticPatch", () => {
  it("adds unique promises and records repeated-beat warnings", () => {
    const plan = { ...samplePlan(), promises: ["The lantern will be lit."] };
    const merged = mergePlanCriticPatch(plan, {
      promisesToAdd: ["The lantern will be lit.", " the LANTERN will be lit. ", "Ada crosses the river."],
      chapterMergeNotes: [],
      reorderNotes: ["Keep the river before the return home."],
      repeatedBeatWarnings: ["Do not restage the chapel scene."]
    });

    expect(merged.promises).toEqual(["The lantern will be lit.", "Ada crosses the river."]);
    expect(merged.continuityRules.some((rule) => rule.includes("chapel scene"))).toBe(true);
    expect(merged.continuityRules).toContain("Keep the river before the return home.");
  });

  it("merges named chapter pairs without regenerating the plan", () => {
    const plan = samplePlan();
    expect(plan.chapters.length).toBeGreaterThan(1);
    const first = plan.chapters[0]!;
    const second = plan.chapters[1]!;
    const merged = mergePlanCriticPatch(plan, {
      promisesToAdd: [],
      chapterMergeNotes: [{ fromIndex: second.index, intoIndex: first.index, note: "Same movement." }],
      reorderNotes: [],
      repeatedBeatWarnings: []
    });

    expect(merged.chapters.length).toBe(plan.chapters.length - 1);
    expect(merged.chapters[0]?.targetPages).toBe(first.targetPages + second.targetPages);
    expect(merged.chapters[0]?.summary).toContain(second.title);
    expect(merged.chapters.every((chapter, index) => chapter.index === index + 1)).toBe(true);
  });

  it("applies every merge against original indices, including intoIndex > fromIndex", () => {
    const plan = planWithChapters([
      { title: "Lantern", targetPages: 2 },
      { title: "Ferry", targetPages: 3 },
      { title: "Crossing", targetPages: 4 },
      { title: "Return", targetPages: 5 }
    ]);
    const merged = mergePlanCriticPatch(plan, {
      promisesToAdd: [],
      chapterMergeNotes: [
        { fromIndex: 1, intoIndex: 3, note: "Fold the lantern into the crossing." },
        { fromIndex: 2, intoIndex: 4, note: "Fold the ferry into the return." }
      ],
      reorderNotes: [],
      repeatedBeatWarnings: []
    });

    expect(merged.chapters).toHaveLength(2);
    expect(merged.chapters[0]?.title).toBe("Crossing");
    expect(merged.chapters[0]?.summary).toContain("Lantern");
    expect(merged.chapters[0]?.summary).toContain("Fold the lantern into the crossing.");
    expect(merged.chapters[0]?.targetPages).toBe(6);
    expect(merged.chapters[1]?.title).toBe("Return");
    expect(merged.chapters[1]?.summary).toContain("Ferry");
    expect(merged.chapters[1]?.summary).toContain("Fold the ferry into the return.");
    expect(merged.chapters[1]?.targetPages).toBe(8);
    expect(merged.chapters.every((chapter, index) => chapter.index === index + 1)).toBe(true);
  });

  it("still merges later-fromIndex pairs when intoIndex is smaller", () => {
    const plan = planWithChapters([
      { title: "Lantern", targetPages: 2 },
      { title: "Ferry", targetPages: 3 },
      { title: "Crossing", targetPages: 4 },
      { title: "Return", targetPages: 5 }
    ]);
    const merged = mergePlanCriticPatch(plan, {
      promisesToAdd: [],
      chapterMergeNotes: [
        { fromIndex: 3, intoIndex: 1, note: "Same opening movement." },
        { fromIndex: 4, intoIndex: 2, note: "Same closing movement." }
      ],
      reorderNotes: [],
      repeatedBeatWarnings: []
    });

    expect(merged.chapters).toHaveLength(2);
    expect(merged.chapters[0]?.title).toBe("Lantern");
    expect(merged.chapters[0]?.summary).toContain("Crossing");
    expect(merged.chapters[0]?.targetPages).toBe(6);
    expect(merged.chapters[1]?.title).toBe("Ferry");
    expect(merged.chapters[1]?.summary).toContain("Return");
    expect(merged.chapters[1]?.targetPages).toBe(8);
    expect(merged.chapters.every((chapter, index) => chapter.index === index + 1)).toBe(true);
  });

  it("applies styleGuidanceRewrites then re-merges required style rules", () => {
    const plan = {
      ...samplePlan(),
      antiAiRules: ["Ask the same questions throughout the book.", "Do not invent evidence."],
      styleContract: {
        localRules: [{ id: "custom", instruction: "Ask the same questions throughout the book." }],
        distributionRules: []
      }
    };
    const merged = mergePlanCriticPatch(plan, {
      promisesToAdd: [],
      chapterMergeNotes: [],
      reorderNotes: [],
      repeatedBeatWarnings: [],
      styleGuidanceRewrites: [
        {
          from: "Ask the same questions throughout the book.",
          to: "Use this question set only in the chapter where it is assigned."
        }
      ]
    });
    expect(merged.antiAiRules.join(" ")).not.toMatch(/Ask the same questions throughout/i);
    expect(JSON.stringify(merged.styleContract)).toMatch(/chapter where it is assigned/i);
  });

  it("keeps stored parallel-structure distribution wording after unrelated styleGuidanceRewrites", () => {
    const userWording = "Ask the same questions throughout the book.";
    const unrelated = "Always distinguish the same categories on every case.";
    const prompt = "Use deliberate parallel structure and the same questions throughout every chapter.";
    const base = samplePlan();
    const plan = {
      ...base,
      antiAiRules: [...base.antiAiRules, unrelated],
      styleContract: {
        localRules: [
          ...(base.styleContract?.localRules ?? []),
          { id: "same-categories-every-case", instruction: unrelated }
        ],
        distributionRules: [
          ...(base.styleContract?.distributionRules ?? []),
          { id: "user-parallel-questions", instruction: userWording }
        ]
      }
    };
    const merged = mergePlanCriticPatch(
      plan,
      {
        promisesToAdd: [],
        chapterMergeNotes: [],
        reorderNotes: [],
        repeatedBeatWarnings: [],
        styleGuidanceRewrites: [
          {
            from: unrelated,
            to: "Use this analytical move only in the chapter where it is assigned."
          }
        ]
      },
      { userPrompt: prompt }
    );

    expect(merged.styleContract?.distributionRules.some((rule) => rule.instruction === userWording)).toBe(true);
  });

  it("does not persist a house rewrite of the parallel-structure line when the user asked for it", () => {
    const userWording = "Ask the same questions throughout the book.";
    const unrelated = "Always distinguish the same categories on every case.";
    const houseRewrite = rewriteRepetitiveStyleInstruction(userWording);
    const prompt = "Use deliberate parallel structure and the same questions throughout every chapter.";
    const base = samplePlan();
    const plan = {
      ...base,
      antiAiRules: [...base.antiAiRules, unrelated],
      styleContract: {
        localRules: [
          ...(base.styleContract?.localRules ?? []),
          { id: "same-categories-every-case", instruction: unrelated }
        ],
        distributionRules: [
          ...(base.styleContract?.distributionRules ?? []),
          { id: "user-parallel-questions", instruction: userWording }
        ]
      }
    };
    const merged = mergePlanCriticPatch(
      plan,
      {
        promisesToAdd: [],
        chapterMergeNotes: [],
        reorderNotes: [],
        repeatedBeatWarnings: [],
        styleGuidanceRewrites: [
          { from: userWording, to: houseRewrite },
          {
            from: unrelated,
            to: "Use this analytical move only in the chapter where it is assigned."
          }
        ]
      },
      { userPrompt: prompt }
    );

    expect(houseRewrite).toMatch(/chapter where it is assigned/i);
    expect(merged.styleContract?.distributionRules.some((rule) => rule.instruction === userWording)).toBe(true);
    expect(merged.styleContract?.distributionRules.some((rule) => rule.instruction === houseRewrite)).toBe(false);
    expect(merged.antiAiRules).not.toContain(unrelated);
    expect(merged.styleContract?.localRules.some((rule) => rule.instruction === unrelated)).toBe(false);
    expect(
      merged.styleContract?.localRules.some((rule) => /chapter where it is assigned/i.test(rule.instruction))
    ).toBe(true);
  });
});

describe("critiquePlan", () => {
  it("tells the critic not to rewrite parallel-structure lines when the user asked for them", async () => {
    const captured: string[] = [];
    await critiquePlan({
      textModel: capturingTextModel(captured),
      plan: samplePlan(),
      userPrompt: "Use deliberate parallel structure and the same questions throughout every chapter."
    });

    expect(captured[0]).toMatch(/Do not emit styleGuidanceRewrites/i);
    expect(captured[0]).not.toMatch(/rewrite them in styleGuidanceRewrites/i);
    expect(captured[1]).toMatch(/deliberate parallel structure/i);
  });

  it("still asks the critic to rewrite repetitive global guidance when the user did not ask for parallel structure", async () => {
    const captured: string[] = [];
    await critiquePlan({
      textModel: capturingTextModel(captured),
      plan: samplePlan(),
      userPrompt: "A survey of irrigation across eras."
    });

    expect(captured[0]).toMatch(/rewrite them in styleGuidanceRewrites/i);
    expect(captured[0]).not.toMatch(/Do not emit styleGuidanceRewrites/i);
  });
});

function capturingTextModel(captured: string[]): TextModelAdapter {
  return {
    async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
      captured.push(options.messages.find((message) => message.role === "system")?.content ?? "");
      captured.push(options.messages.find((message) => message.role === "user")?.content ?? "");
      const patch = {
        promisesToAdd: [],
        chapterMergeNotes: [],
        reorderNotes: [],
        repeatedBeatWarnings: [],
        styleGuidanceRewrites: []
      };
      return {
        data: patch as T,
        text: JSON.stringify(patch),
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
}
