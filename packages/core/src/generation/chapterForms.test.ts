import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import {
  compositionVarietyIssues,
  fallbackChapterComposition,
  formPaletteFor,
  normalizeChapterCompositions,
  planChapterForms,
  positionalIssues,
  rotatePositionsForVariety,
  settleFormVariety,
  sectionCountForPages,
  type ChapterComposition,
  type ChapterFormRange
} from "./chapterForms.js";

const input: CreateProjectInput = {
  prompt: "A global history of aggression and its causes.",
  category: "HISTORY",
  targetPages: 24,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

function ranges(): ChapterFormRange[] {
  const plan = makeFallbackPlan(input);
  let start = 1;
  return plan.chapters.map((chapter) => {
    const range = { chapter, startPage: start, endPage: start + chapter.targetPages - 1 };
    start = range.endPage + 1;
    return range;
  });
}

const palette = formPaletteFor("analytical-history");

function composition(chapterIndex: number, forms: string[]): ChapterComposition {
  return {
    chapterIndex,
    throughLine: `Chapter ${chapterIndex}`,
    sections: forms.map((form, index) => ({ form, subject: `Subject ${index}`, share: 1 / forms.length, owns: [] })),
    landing: [
      "Marcus signs the ledger at Housesteads in 1534.",
      "Ioventius loses his third mule on the Stanegate in 1541.",
      "The Corbridge granary burns on the ides of March, 1547.",
      "Aelia Severa's petition reaches Eboracum unread.",
      "The last cart through the north gate at Vindolanda carries nothing but its driver."
    ][(chapterIndex - 1) % 5]!,
    avoid: []
  };
}

describe("sectionCountForPages", () => {
  it("scales with the chapter's pages within three to eight", () => {
    expect(sectionCountForPages(2)).toEqual({ min: 2, max: 3 });
    expect(sectionCountForPages(8)).toEqual({ min: 4, max: 7 });
    expect(sectionCountForPages(30)).toEqual({ min: 4, max: 8 });
  });
});

describe("compositionVarietyIssues", () => {
  it("passes a varied plan", () => {
    const plan = [
      composition(1, ["scene", "close-reading", "argument", "aftermath"]),
      composition(2, ["portrait", "mechanism", "counterargument", "open-question"]),
      composition(3, ["comparison", "scene", "catalogue", "argument"])
    ];
    expect(compositionVarietyIssues(plan, palette)).toEqual([]);
  });

  it("names doubled forms, repeated sequences, shared openings and over-used forms", () => {
    const plan = [
      composition(1, ["argument", "argument", "argument"]),
      composition(2, ["argument", "scene", "argument"]),
      composition(3, ["argument", "scene", "argument"]),
      composition(4, ["made-up", "scene"])
    ];
    const issues = compositionVarietyIssues(plan, palette);
    expect(issues.some((issue) => issue.includes("more than half"))).toBe(true);
    expect(issues.some((issue) => issue.includes("two consecutive"))).toBe(true);
    expect(issues.some((issue) => issue.includes("exact form sequence"))).toBe(true);
    expect(issues.some((issue) => issue.includes("same form the previous chapter opened with"))).toBe(true);
    expect(issues.some((issue) => issue.includes("outside the palette"))).toBe(true);
    expect(issues.some((issue) => issue.includes("under 40%"))).toBe(true);
  });
});

describe("positionalIssues", () => {
  it("flags one form sitting in the same position in most chapters, and the swap clears it", () => {
    const plan = Array.from({ length: 6 }, (_, index) =>
      composition(index + 1, [["scene", "close-reading"][index % 2]!, ["mechanism", "portrait"][index % 2]!, "comparison", ["argument", "aftermath"][index % 2]!])
    );
    expect(positionalIssues(plan).some((issue) => issue.includes('"comparison" sits in position 3'))).toBe(true);
    expect(positionalIssues(rotatePositionsForVariety(plan))).toEqual([]);
  });
});

describe("rotateFormsForVariety", () => {
  it("clears every deterministic issue from a monotonous plan", () => {
    const plan = Array.from({ length: 5 }, (_, index) =>
      composition(index + 1, ["argument", "argument", "argument", "argument"])
    );
    const rotated = settleFormVariety(plan, palette);
    expect(compositionVarietyIssues(rotated, palette).filter((issue) => !issue.includes("sits in position"))).toEqual([]);
    expect(positionalIssues(rotated).length).toBeLessThanOrEqual(positionalIssues(plan).length);
    expect(rotated.map((chapter) => chapter.sections.map((section) => section.subject))).toEqual(
      plan.map((chapter) => chapter.sections.map((section) => section.subject))
    );
  });
});

describe("normalizeChapterCompositions", () => {
  it("canonicalises forms, fills missing chapters, clamps counts and renormalises shares", () => {
    const [first, second] = ranges();
    const normalized = normalizeChapterCompositions(
      {
        compositions: [
          {
            chapterIndex: first!.chapter.index,
            throughLine: "Through",
            sections: [
              { form: "Close Reading", subject: "A", share: 2, owns: ["x"] },
              { form: "argument", subject: "B", share: 2 },
              { form: "scene", subject: "C", share: 4 }
            ],
            landing: "Land",
            avoid: []
          }
        ]
      },
      [first!, second!],
      palette
    );
    expect(normalized).toHaveLength(2);
    // A twelve-page chapter has a floor of four sections; the fourth is filled in.
    expect(normalized[0]!.sections.slice(0, 3).map((section) => section.form)).toEqual(["close-reading", "argument", "scene"]);
    expect(normalized[0]!.sections).toHaveLength(4);
    expect(normalized[0]!.sections.reduce((sum, section) => sum + (section.share ?? 0), 0)).toBeCloseTo(1, 6);
    expect(normalized[0]!.sections[2]!.share!).toBeGreaterThan(normalized[0]!.sections[0]!.share!);
    expect(normalized[1]!.chapterIndex).toBe(second!.chapter.index);
    expect(normalized[1]!.sections.length).toBeGreaterThanOrEqual(sectionCountForPages(second!.endPage - second!.startPage + 1).min);
  });

  it("falls back deterministically when the answer is unusable", () => {
    const [first] = ranges();
    const normalized = normalizeChapterCompositions("nonsense", [first!], palette);
    expect(normalized[0]).toEqual(fallbackChapterComposition(first!, palette, 0));
  });
});

describe("planChapterForms", () => {
  it("plans every chapter through the fake adapter and passes the variety check", async () => {
    const plan = makeFallbackPlan(input);
    const result = await planChapterForms({ input, plan, ranges: ranges(), textModel: new FakeTextModelAdapter(input) });
    expect(result.compositions.map((composition) => composition.chapterIndex)).toEqual(plan.chapters.map((chapter) => chapter.index));
    expect(result.issues).toEqual([]);
    for (const composition of result.compositions) {
      expect(composition.sections.length).toBeGreaterThanOrEqual(3);
      expect(composition.landing).not.toBe("");
    }
  });

  it("keeps fixed compositions from an earlier run and plans only the rest", async () => {
    const plan = makeFallbackPlan(input);
    const all = ranges();
    const fixed = [composition(all[0]!.chapter.index, ["scene", "close-reading", "argument"])];
    const result = await planChapterForms({ input, plan, ranges: all, fixed, textModel: new FakeTextModelAdapter(input) });
    expect(result.compositions[0]).toEqual(fixed[0]);
    expect(result.compositions).toHaveLength(all.length);
  });

  it("drafts from the rotated fallback when the provider fails, and lets a stop through", async () => {
    const plan = makeFallbackPlan(input);
    const failing = {
      ...new FakeTextModelAdapter(input),
      generateJson: async () => {
        throw new Error("provider down");
      }
    } as unknown as FakeTextModelAdapter;
    const result = await planChapterForms({ input, plan, ranges: ranges(), textModel: failing });
    expect(result.source).toBe("fallback");
    expect(result.compositions).toHaveLength(plan.chapters.length);

    const stop = new Error("stopped");
    stop.name = "StopRequestedError";
    const stopping = {
      ...new FakeTextModelAdapter(input),
      generateJson: async () => {
        throw stop;
      }
    } as unknown as FakeTextModelAdapter;
    await expect(planChapterForms({ input, plan, ranges: ranges(), textModel: stopping })).rejects.toBe(stop);
  });
});
