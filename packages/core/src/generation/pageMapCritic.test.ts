import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { critiquePageMap, mergePageMapCriticPatch } from "./pageMapCritic.js";
import type { BookPlan, ChapterBrief, CreateProjectInput } from "../schemas/book.js";

/**
 * The critic is the fifth writer of page 1's brief and the one that gets the
 * last word, so the first-page contract is asserted on both of its halves: the
 * prompt a `beatPatch` is written under, and the `missingEndingPressure`
 * substitution, which is our own sentence rather than a model's.
 */

const openingHook = "Jack is already halfway over the chapel wall when the bell starts ringing for him.";

/**
 * The book the critic is handed beside the map, which is where all three of the
 * first-page contract's questions are answered from: `targetPages` ranks page 1
 * against the book's last page, `plan.openingHook` is the commitment a patch has
 * to keep, and `mediaSettings.mobile.import` is the provenance that says whether
 * this book's opening is ours to commit at all.
 */
function book(options: {
  targetPages: number;
  hook?: string;
  imported?: boolean;
}): { input: CreateProjectInput; plan: BookPlan } {
  const input = {
    prompt: "Ada walks the river road, a character-led story about leaving.",
    category: "STORY",
    targetPages: options.targetPages,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral",
      ...(options.imported
        ? { mobile: { bookType: "custom", import: { importId: "imp_1", fileName: "chapel.docx", format: "docx" } } }
        : {})
    }
  } as CreateProjectInput;
  const base = makeFallbackPlan(input);
  return { input, plan: options.hook ? { ...base, openingHook: options.hook } : base };
}

const briefs: ChapterBrief[] = [
  {
    chapterIndex: 1,
    title: "Opening",
    summary: "Ada leaves town.",
    continuityFocus: [],
    pages: [
      {
        pageIndex: 1,
        chapterIndex: 1,
        purpose: "Establish Ada",
        beat: "Ada packs the lantern.",
        requiredContinuity: [],
        endingPressure: ""
      },
      {
        pageIndex: 2,
        chapterIndex: 1,
        purpose: "Establish Ada",
        beat: "Ada packs again.",
        requiredContinuity: [],
        endingPressure: "Ask why she delayed."
      }
    ]
  },
  {
    chapterIndex: 2,
    title: "The road",
    summary: "Ada walks the river road.",
    continuityFocus: [],
    pages: [
      {
        pageIndex: 4,
        chapterIndex: 2,
        purpose: "Cross the ford",
        beat: "Ada wades the ford.",
        requiredContinuity: [],
        endingPressure: "The water is rising."
      },
      {
        pageIndex: 5,
        chapterIndex: 2,
        purpose: "Reach the far bank",
        beat: "Ada reaches the far bank.",
        requiredContinuity: [],
        endingPressure: ""
      }
    ]
  }
];

/** The last page of the book `briefs` describes. Passed in, never inferred. */
const lastPageIndex = 5;

/** The same book cut down to the case where page 1 is also the last page. */
const onePageBriefs: ChapterBrief[] = [{ ...briefs[0]!, pages: [briefs[0]!.pages[0]!] }];

function capturingJsonModel(rawData: unknown): {
  model: TextModelAdapter;
  system?: string;
  payload?: Record<string, any>;
} {
  const capture: { model: TextModelAdapter; system?: string; payload?: Record<string, any> } = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.system = options.messages[0]?.content ?? "";
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, any>;
        return {
          data: options.schema.parse(rawData),
          text: JSON.stringify(rawData),
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    }
  };
  return capture;
}

const emptyPatch = {
  beatPatches: [],
  duplicatePurposeWarnings: [],
  missingEndingPressure: [],
  unscheduledPromises: []
};

describe("critiquePageMap first-page contract", () => {
  it("states the first-page rule and hands the critic the plan's openingHook", async () => {
    const capture = capturingJsonModel(emptyPatch);

    await critiquePageMap({
      textModel: capture.model,
      briefs,
      promises: [],
      ...book({ targetPages: lastPageIndex, hook: openingHook })
    });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/endingPressure must leave a specific tension/);
    expect(capture.system).toMatch(/openingHook is the plan's commitment/);
    expect(capture.payload?.openingHook).toBe(openingHook);
  });

  it("keeps the first-page rule but sends no openingHook when the plan has none", async () => {
    const capture = capturingJsonModel(emptyPatch);

    await critiquePageMap({ textModel: capture.model, briefs, promises: [], ...book({ targetPages: lastPageIndex }) });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.payload?.openingHook).toBeUndefined();
  });

  it("brief page 1 of a one-page book to close the book instead of hand off", async () => {
    const capture = capturingJsonModel(emptyPatch);

    await critiquePageMap({
      textModel: capture.model,
      briefs: onePageBriefs,
      promises: [],
      ...book({ targetPages: 1, hook: openingHook })
    });

    // Page 1 is still the reader's first impression and still owes the plan's
    // hook; only the handoff half of the contract flips, because the patch this
    // prompt licenses replaces the same field the substitution would have.
    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/openingHook is the plan's commitment/);
    expect(capture.payload?.openingHook).toBe(openingHook);
    expect(capture.system).not.toMatch(/second page has to answer/);
    expect(capture.system).toMatch(/also this book's last page/);
    expect(capture.system).toMatch(/Resolve the book's central promise/);
  });

  it("reads a map that stopped at page 1 as a truncated map, not as a one-page book", async () => {
    const capture = capturingJsonModel(emptyPatch);

    // Same briefs as the case above, and the opposite contract, because the only
    // thing that changed is the book. A map short of `targetPages` is the very
    // failure the brief repair loop exists for, so the highest index it holds is
    // not evidence of anything — and a page 1 briefed to close a twelve-page
    // book is the reader's first impression spending the ending on page one.
    await critiquePageMap({
      textModel: capture.model,
      briefs: onePageBriefs,
      promises: [],
      ...book({ targetPages: 12, hook: openingHook })
    });

    expect(capture.system).toMatch(/endingPressure must leave a specific tension/);
    expect(capture.system).not.toMatch(/also this book's last page/);
  });

  it("names no hook for an imported manuscript, whose plan invented one after the fact", async () => {
    const capture = capturingJsonModel(emptyPatch);

    // This pass gets the last word over page 1's brief, and it is the one
    // producer that used to be handed the hook as a bare string by the worker —
    // so it was the last door an import's invented hook could reach a model
    // through. An import's page 1 is the author's own first sentence; a patch
    // told to assign a hook that sentence was never written to is a rewrite of
    // it, and the writer prompts are gated too, so the hook's words would not
    // even be in the prompt that drafts the replacement.
    await critiquePageMap({
      textModel: capture.model,
      briefs,
      promises: [],
      ...book({ targetPages: lastPageIndex, hook: openingHook, imported: true })
    });

    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.system).not.toContain(openingHook);
    expect(capture.payload?.openingHook).toBeUndefined();
    // The ban half is not gated on the brief side: a patch is a production
    // assignment for prose about to be generated.
    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/endingPressure must leave a specific tension/);
  });
});

describe("mergePageMapCriticPatch", () => {
  it("patches duplicate purpose and fills missing endingPressure", () => {
    const merged = mergePageMapCriticPatch(briefs, {
      beatPatches: [
        {
          pageIndex: 2,
          purpose: "Ada decides to leave",
          beat: "Ada chooses the river road."
        }
      ],
      duplicatePurposeWarnings: ["Pages 1 and 2 shared a purpose."],
      missingEndingPressure: [1, 5],
      unscheduledPromises: ["The lantern will be lit."]
    }, lastPageIndex);

    // The substitution is deterministic code, so page 1 is the one page it must
    // not answer with the generic line the rest of the book gets.
    expect(merged[0]?.pages[0]?.endingPressure).toBe(
      "End the first page with a specific tension or open question the second page must answer."
    );
    // Page 5 is this book's last page, so the generic line would hand it a
    // consequence to carry into page 6.
    expect(merged[1]?.pages[1]?.endingPressure).toBe(
      "Resolve the book's central promise with a concrete final consequence."
    );
    expect(merged[1]?.pages[1]?.endingPressure).not.toMatch(/next page/);
    expect(merged[0]?.pages[1]?.purpose).toBe("Ada decides to leave");
    expect(merged[0]?.continuityFocus.some((line) => line.includes("lantern"))).toBe(true);
  });

  it("still carries a middle page's consequence into the next page", () => {
    const middle: ChapterBrief[] = [
      { ...briefs[0]!, pages: [briefs[0]!.pages[0]!, { ...briefs[0]!.pages[1]!, endingPressure: "" }] },
      briefs[1]!
    ];

    const merged = mergePageMapCriticPatch(middle, { ...emptyPatch, missingEndingPressure: [2] }, lastPageIndex);

    expect(merged[0]?.pages[1]?.endingPressure).toBe("Carry a concrete consequence into the next page.");
  });

  it("leaves a one-page book's only page out of the first-page pressure", () => {
    const onePage: ChapterBrief[] = [
      {
        ...briefs[0]!,
        pages: [briefs[0]!.pages[0]!]
      }
    ];

    const merged = mergePageMapCriticPatch(
      onePage,
      { beatPatches: [], duplicatePurposeWarnings: [], missingEndingPressure: [1], unscheduledPromises: [] },
      1
    );

    expect(merged[0]?.pages[0]?.endingPressure).not.toMatch(/second page must answer/);
    // The collision resolves in favour of the ending rather than into the
    // generic line, which would hand the book's only page a next page.
    expect(merged[0]?.pages[0]?.endingPressure).toBe(
      "Resolve the book's central promise with a concrete final consequence."
    );
    expect(merged[0]?.pages[0]?.endingPressure).not.toMatch(/next page/);
  });

  it("keeps an ending pressure the map already had", () => {
    const merged = mergePageMapCriticPatch(briefs, { ...emptyPatch, missingEndingPressure: [2] }, lastPageIndex);

    expect(merged[0]?.pages[1]?.endingPressure).toBe("Ask why she delayed.");
  });

  it("does not end the book on a page the map merely stopped at", () => {
    // The substitution is our own sentence, so this is the half where a short
    // map does its damage silently: page 5 is the highest index these briefs
    // hold and a middle page of the twelve-page book they belong to.
    const merged = mergePageMapCriticPatch(briefs, { ...emptyPatch, missingEndingPressure: [5] }, 12);

    expect(merged[1]?.pages[1]?.endingPressure).toBe("Carry a concrete consequence into the next page.");
    expect(merged[1]?.pages[1]?.endingPressure).not.toMatch(/Resolve the book's central promise/);
  });
});
