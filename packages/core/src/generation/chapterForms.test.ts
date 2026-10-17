import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import {
  assignedSectionCount,
  capFigures,
  capOpenQuestionEndings,
  figureCapFor,
  compositionVarietyIssues,
  fallbackChapterComposition,
  formPaletteFor,
  MAX_CHAPTER_SECTIONS,
  normalizeChapterCompositions,
  planChapterForms,
  positionalIssues,
  rotatePositionsForVariety,
  SECTION_ASK_WORDS,
  settleFormVariety,
  sectionCountForPages,
  SUSTAINED_SECTION_WORDS,
  sustainedSectionShare,
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

  // The writer returns 430–650 words a section whatever the section is asked
  // for, so a long chapter's floor is its words over SECTION_ASK_WORDS: the
  // 13-page, 4,940-word chapter that came in at 55–82% in four sections is
  // planned in nine or ten.
  it("raises a long chapter's floor from its words and leaves a short chapter's alone", () => {
    expect(sectionCountForPages(13, 4940)).toEqual({ min: 9, max: 10 });
    expect(sectionCountForPages(12, 4420)).toEqual({ min: 8, max: 9 });
    expect(sectionCountForPages(6, 2280)).toEqual({ min: 4, max: 5 });
    // Words never lower the page-based floor or ceiling.
    expect(sectionCountForPages(8, 100)).toEqual(sectionCountForPages(8));
    expect(sectionCountForPages(8, 0)).toEqual(sectionCountForPages(8));
    // A 14-page chapter at 570 words a page is capped at MAX_CHAPTER_SECTIONS.
    expect(sectionCountForPages(14, 7980)).toEqual({ min: MAX_CHAPTER_SECTIONS, max: MAX_CHAPTER_SECTIONS });
    expect(Math.ceil(4940 / SECTION_ASK_WORDS)).toBe(9);
  });

  it("assigns the walked count from the words-based range", () => {
    // Chapter 9's offset is 0, so it used to get the four-section floor of a 13-page chapter.
    expect(assignedSectionCount(9, 13)).toEqual({ min: 4, max: 4 });
    expect(assignedSectionCount(9, 13, 4940)).toEqual({ min: 9, max: 9 });
    expect(assignedSectionCount(3, 13, 4940)).toEqual({ min: 10, max: 10 });
  });
});

describe("sustainedSectionShare", () => {
  it("is 40% of a short chapter and SUSTAINED_SECTION_WORDS of a long one, never under 15%", () => {
    expect(sustainedSectionShare()).toBe(0.4);
    expect(sustainedSectionShare(2000)).toBe(0.4);
    expect(sustainedSectionShare(3040)).toBe(0.33);
    expect(sustainedSectionShare(4940)).toBe(0.2);
    expect(Math.round(sustainedSectionShare(4940) * 4940)).toBeLessThanOrEqual(SUSTAINED_SECTION_WORDS);
    expect(sustainedSectionShare(7980)).toBe(0.15);
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

describe("capOpenQuestionEndings", () => {
  const ending = (chapterIndex: number) => composition(chapterIndex, ["scene", "mechanism", "open-question"]);

  it("keeps two chapters ending on an open question and moves the rest off the landing", () => {
    const plan = [ending(1), ending(2), ending(3), ending(4)];
    const capped = capOpenQuestionEndings(plan, palette);
    expect(capped.map((chapter) => chapter.sections.at(-1)!.form)).toEqual([
      "open-question",
      "open-question",
      "mechanism",
      "mechanism"
    ]);
    // The form survives; only its position moved.
    expect(capped[2]!.sections.map((section) => section.form)).toEqual(["scene", "open-question", "mechanism"]);
    expect(capped.map((chapter) => chapter.sections.map((section) => section.subject))).toEqual(
      plan.map((chapter) => chapter.sections.map((section) => section.subject))
    );
  });

  it("replaces the form outright in a one-section chapter and is pure and idempotent", () => {
    const plan = [ending(1), ending(2), composition(3, ["open-question"])];
    const capped = capOpenQuestionEndings(plan, palette);
    expect(capped[2]!.sections[0]!.form).toBe(palette.find((form) => form.id !== "open-question")!.id);
    expect(capOpenQuestionEndings(capped, palette)).toEqual(capped);
    expect(plan[2]!.sections[0]!.form).toBe("open-question");
  });

  it("leaves a plan that never lands on an open question alone", () => {
    const plan = [composition(1, ["open-question", "scene"]), composition(2, ["scene", "argument"])];
    expect(capOpenQuestionEndings(plan, palette)).toEqual(plan);
  });

  it("is applied by settleFormVariety", () => {
    const plan = Array.from({ length: 5 }, (_, index) => ending(index + 1));
    const settled = settleFormVariety(plan, palette);
    expect(settled.filter((chapter) => chapter.sections.at(-1)!.form === "open-question").length).toBeLessThanOrEqual(2);
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

  it("makes one call for a monotonous plan and settles it by rotation, with no repair call (removed 2026-10-16)", async () => {
    const plan = makeFallbackPlan(input);
    const all = ranges();
    let calls = 0;
    const monotonous = {
      ...new FakeTextModelAdapter(input),
      generateJson: async () => {
        calls += 1;
        const chapters = all.map((range) => composition(range.chapter.index, ["scene", "scene", "argument", "argument"]));
        return { data: { chapters }, text: JSON.stringify({ chapters }) };
      }
    } as unknown as FakeTextModelAdapter;
    const rotated = await planChapterForms({ input, plan, ranges: all, textModel: monotonous });
    expect(calls).toBe(1);
    expect(rotated.source).toBe("rotated");
    expect(rotated.issues).toEqual([]);
  });
});

describe("section counts from the chapter's words", () => {
  it("tells the planner each chapter's words, its walked count and its sustained share, and fills a thin answer to the words-based floor", async () => {
    const seen: GenerateJsonOptions<unknown>[] = [];
    const fake = new FakeTextModelAdapter(input);
    const recording = {
      ...fake,
      generateJson: (options: GenerateJsonOptions<unknown>) => {
        seen.push(options);
        return fake.generateJson(options);
      }
    } as unknown as FakeTextModelAdapter;
    const [first, ...rest] = ranges();
    const long: ChapterFormRange = { ...first!, endPage: first!.startPage + 12, words: 4940 };
    const result = await planChapterForms({ input, plan: makeFallbackPlan(input), ranges: [long, ...rest], textModel: recording });
    const payload = JSON.parse(seen[0]!.messages[1]!.content) as { chapters: Array<Record<string, unknown>> };
    const chapter = payload.chapters.find((entry) => entry.chapterIndex === long.chapter.index)!;
    expect(chapter.pages).toBe(13);
    expect(chapter.words).toBe(4940);
    expect(chapter.sectionCount).toEqual(assignedSectionCount(long.chapter.index, 13, 4940));
    expect(chapter.sustainedShare).toBe(0.2);
    // A range without words keeps the page-based assignment and the 40% stretch.
    const plain = payload.chapters.find((entry) => entry.chapterIndex === rest[0]!.chapter.index)!;
    expect(plain.words).toBeUndefined();
    expect(plain.sustainedShare).toBe(0.4);
    expect(seen[0]!.messages[0]!.content).toContain("at least its sustainedShare of its length");
    // The fake answers four sections; the words-based floor fills the rest deterministically.
    const planned = result.compositions.find((entry) => entry.chapterIndex === long.chapter.index)!;
    expect(planned.sections.length).toBeGreaterThanOrEqual(sectionCountForPages(13, 4940).min);
    expect(planned.sections.reduce((sum, section) => sum + (section.share ?? 0), 0)).toBeCloseTo(1, 6);
    expect(compositionVarietyIssues(result.compositions, palette)).toEqual([]);
  });
});

describe("figures in the form plan", () => {
  const figure = (source: string) => ({ kind: "bar" as const, shows: "carts by decade", source });
  const chapters = () =>
    [1, 2, 3, 4].map((index) => {
      const base = composition(index, ["scene", "argument", "catalogue"]);
      return {
        ...base,
        sections: base.sections.map((section, at) => ({
          ...section,
          ...(at === 0 ? { figure: figure(index === 2 ? "" : "the ledger") } : at === 1 && index === 1 ? { figure: figure("a second one") } : {})
        }))
      };
    });

  it("keeps one figure per chapter and at most half the book's chapters, sourced ones first", () => {
    const capped = capFigures(chapters(), { maxPerBook: 2 });
    expect(capped[0]!.sections.filter((section) => section.figure)).toHaveLength(1);
    expect(capped[0]!.sections[0]!.figure?.source).toBe("the ledger");
    expect(capped.map((entry) => entry.sections.some((section) => section.figure))).toEqual([true, false, true, false]);
    expect(capFigures(chapters(), { maxPerBook: 0 }).every((entry) => entry.sections.every((section) => !section.figure))).toBe(true);
    expect(capFigures(chapters(), { maxPerBook: 1, keep: new Set([4]) }).map((entry) => entry.sections.some((section) => section.figure))).toEqual([
      false,
      false,
      false,
      true
    ]);
    expect(capped.map((entry) => entry.sections.map((section) => section.form))).toEqual(chapters().map((entry) => entry.sections.map((section) => section.form)));
  });

  it("shows the planner the figure rule and key only for an eligible book, and strips figures a disabled gate is handed", async () => {
    const seen: GenerateJsonOptions<unknown>[] = [];
    const fake = new FakeTextModelAdapter(input);
    const recording = {
      ...fake,
      generateJson: (options: GenerateJsonOptions<unknown>) => {
        seen.push(options);
        return fake.generateJson(options);
      }
    } as unknown as FakeTextModelAdapter;
    const cap = figureCapFor(ranges().length);
    const withFigures = await planChapterForms({ input, plan: makeFallbackPlan(input), ranges: ranges(), textModel: recording, figures: true });
    expect(seen[0]!.messages[0]!.content).toContain("carries figure — {kind: bar|line|pie, shows, source}");
    expect(seen[0]!.messages[1]!.content).toContain('"figure"');
    const kinds = withFigures.compositions.flatMap((entry) => entry.sections.filter((section) => section.figure).map((section) => section.figure!.kind));
    expect(kinds).toEqual(["bar", "flow"].slice(0, Math.min(2, cap)));

    seen.length = 0;
    const without = await planChapterForms({ input, plan: makeFallbackPlan(input), ranges: ranges(), textModel: recording });
    expect(seen[0]!.messages[0]!.content).not.toContain("figure");
    expect(seen[0]!.messages[1]!.content).not.toContain("figure");
    expect(without.compositions.every((entry) => entry.sections.every((section) => !section.figure))).toBe(true);
  });

  it("drops a figure the planner spelled unreadably without losing the chapter's plan", () => {
    const raw = {
      chapters: [
        {
          chapterIndex: 1,
          throughLine: "t",
          sections: [
            { form: "scene", subject: "The first subject", owns: [], figure: { kind: "chart", shows: "x" } },
            { form: "argument", subject: "The second subject", owns: [], figure: { kind: "line", shows: "y", source: "z" } },
            { form: "catalogue", subject: "The third subject", owns: [] }
          ],
          landing: "l",
          avoid: []
        }
      ]
    };
    const [first] = normalizeChapterCompositions(raw, ranges().slice(0, 1), palette);
    expect(first!.sections[0]!.subject).toBe("The first subject");
    expect(first!.sections[0]!.figure).toBeUndefined();
    expect(first!.sections[1]!.figure).toEqual({ kind: "line", shows: "y", source: "z" });
  });
});
