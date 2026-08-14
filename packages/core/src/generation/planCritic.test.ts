import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { mergePlanCriticPatch } from "./planCritic.js";

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
      promisesToAdd: ["The lantern will be lit.", "Ada crosses the river."],
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
});
