import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput, PageQualityReport } from "../schemas/book.js";
import {
  REWRITE_TEMPERATURE_CEILING,
  generateChapterBrief,
  generateWholeBookPageMap,
  repairPageBrief
} from "./pages.js";

/**
 * The first-page contract in the production map. Four paths brief page 1 — the
 * whole-book map, the per-chapter briefs the chunked path fans out, the
 * deterministic fallback, and the QA repair that rewrites whichever of the
 * three wrote the brief — and a real book almost never reaches the third of
 * them, so each is asserted here. The fallback's chapter arithmetic itself is
 * covered in pages.test.ts, and the fifth writer — the page-map critic, which
 * runs last over whatever these four wrote — in pageMapCritic.test.ts.
 */

const input: CreateProjectInput = {
  prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
  category: "STORY",
  targetPages: 3,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral" as const
  }
};

const openingHook = "Jack is already halfway over the chapel wall when the bell starts ringing for him.";

/**
 * The collision every producer has to resolve the same way: `targetPages: 1` is
 * legal (the mobile create schema's `minimum`), so page 1 is the book's last
 * page too and the two halves of the contract contradict each other.
 */
const onePageInput: CreateProjectInput = { ...input, targetPages: 1 };

/**
 * The same book arriving as an imported manuscript. `mediaSettings.mobile.import`
 * is written by the import route and carried through every plan version's input
 * snapshot, so it is the only difference — and it is the difference between
 * briefing a page the pipeline is about to write and briefing the author's own
 * first sentence.
 *
 * Its plan still carries an `openingHook` in every case below, because that is
 * the live failure: `synthesizeImportedBookPlan` sets none, `revisePlanningPackage`
 * preserves-or-improves one unconditionally, so a replanned import has a hook a
 * model invented from a premise field without ever reading page 1. Assigning it
 * in page 1's brief tells the writer to deliver a hook the writer prompt — gated
 * on the same fact — will not carry.
 */
const importedInput: CreateProjectInput = {
  ...input,
  mediaSettings: {
    ...input.mediaSettings,
    mobile: { bookType: "custom", import: { importId: "imp_1", fileName: "chapel.docx", format: "docx" } }
  }
} as CreateProjectInput;

const failingModel: TextModelAdapter = {
  async generateText() {
    return { text: "", model: "test-model", provider: "test" };
  },
  async generateJson() {
    const error = new Error("Model returned invalid JSON. Unterminated string in JSON at position 8111");
    error.name = "GeminiJsonParseError";
    throw error;
  },
  async *streamText() {
    yield "";
  },
  generateWithTools: unsupportedGenerateWithTools
};

type JsonCapture = {
  model: TextModelAdapter;
  system?: string;
  payload?: Record<string, any>;
  temperature?: number | undefined;
};

function capturingJsonModel(rawData: unknown): JsonCapture {
  const capture: JsonCapture = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.system = options.messages[0]?.content ?? "";
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, any>;
        capture.temperature = options.temperature;
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

function modelPageBeat(pageIndex: number, chapterIndex: number) {
  return {
    pageIndex,
    chapterIndex,
    purpose: `Advance the book on page ${pageIndex}.`,
    beat: `A concrete turn for page ${pageIndex}.`,
    requiredContinuity: [],
    endingPressure: `A reason page ${pageIndex + 1} must continue.`
  };
}

describe("whole-book page map first-page contract", () => {
  it("states the first-page rule and hands the model the plan's openingHook", async () => {
    const capture = capturingJsonModel({
      pages: [modelPageBeat(1, 1), modelPageBeat(2, 1), modelPageBeat(3, 1)]
    });
    const plan: BookPlan = { ...makeFallbackPlan(input), openingHook };

    await generateWholeBookPageMap({ input, plan, textModel: capture.model });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/endingPressure must leave a specific tension/);
    expect(capture.system).toMatch(/openingHook is the plan's commitment/);
    expect(capture.payload?.openingHook).toBe(openingHook);
  });

  it("keeps the first-page rule but sends no openingHook when the plan has none", async () => {
    const capture = capturingJsonModel({
      pages: [modelPageBeat(1, 1), modelPageBeat(2, 1), modelPageBeat(3, 1)]
    });
    const plan = makeFallbackPlan(input);

    await generateWholeBookPageMap({ input, plan, textModel: capture.model });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.payload?.openingHook).toBeUndefined();
  });

  it("briefs a one-page book to close the book instead of hand off to a second page", async () => {
    const capture = capturingJsonModel({ pages: [modelPageBeat(1, 1)] });
    const plan: BookPlan = { ...makeFallbackPlan(onePageInput), openingHook };

    await generateWholeBookPageMap({ input: onePageInput, plan, textModel: capture.model });

    // The opening half of the contract still holds — page 1 is still the
    // reader's first impression and still owes the plan's hook. Only the
    // handoff flips, and it flips to the sentence the deterministic fallback
    // writes for the same book.
    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/openingHook is the plan's commitment/);
    expect(capture.payload?.openingHook).toBe(openingHook);
    expect(capture.system).not.toMatch(/second page has to answer/);
    expect(capture.system).toMatch(/also this book's last page/);
    expect(capture.system).toMatch(/Resolve the book's central promise/);
  });

  it("assigns no openingHook when the book is an imported manuscript", async () => {
    const capture = capturingJsonModel({
      pages: [modelPageBeat(1, 1), modelPageBeat(2, 1), modelPageBeat(3, 1)]
    });
    const plan: BookPlan = { ...makeFallbackPlan(importedInput), openingHook };

    await generateWholeBookPageMap({ input: importedInput, plan, textModel: capture.model });

    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.system).not.toContain(openingHook);
    expect(capture.payload?.openingHook).toBeUndefined();
    // Only the hook half is gated on the brief side. A map is a production
    // assignment for prose about to be generated, so the opening ban still
    // reaches an import's regenerated page 1.
    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/endingPressure must leave a specific tension/);
  });
});

describe("chapter brief first-page contract", () => {
  const chunkedInput: CreateProjectInput = { ...input, targetPages: 40 };
  const chunkedPlan: BookPlan = { ...makeFallbackPlan(chunkedInput), openingHook };

  function briefResponse(pageIndexes: number[], chapterIndex: number) {
    return {
      chapterIndex,
      title: "Chapter",
      summary: "Summary",
      pages: pageIndexes.map((pageIndex) => modelPageBeat(pageIndex, chapterIndex)),
      continuityFocus: []
    };
  }

  it("gives the chapter that contains page 1 the first-page rule and the openingHook", async () => {
    const capture = capturingJsonModel(briefResponse([1, 2, 3], 1));

    await generateChapterBrief({
      input: chunkedInput,
      plan: chunkedPlan,
      chapter: chunkedPlan.chapters[0]!,
      chapterPageStart: 1,
      chapterPageEnd: 3,
      textModel: capture.model
    });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/openingHook is the plan's commitment/);
    expect(capture.payload?.openingHook).toBe(openingHook);
  });

  it("forbids assigning a named archive when the plan has no citeable notes", async () => {
    const capture = capturingJsonModel(briefResponse([1, 2, 3], 1));
    const plan: BookPlan = {
      ...chunkedPlan,
      researchNotes: [
        {
          query: "bootstrap",
          title: "Grounded planning summary",
          summary: "A URL-less summary that cannot appear in Sources."
        }
      ]
    };

    await generateChapterBrief({
      input: chunkedInput,
      plan,
      chapter: plan.chapters[0]!,
      chapterPageStart: 1,
      chapterPageEnd: 3,
      textModel: capture.model
    });

    expect(capture.system).toContain("researchNotes is empty:");
    expect(capture.system).toContain("do not assign, require, invent, or reject prose for omitting a diary");
    expect(capture.payload?.researchNotes).toEqual([]);
  });

  it("briefs a one-page book's only chapter to close the book", async () => {
    const capture = capturingJsonModel(briefResponse([1], 1));
    const plan: BookPlan = { ...makeFallbackPlan(onePageInput), openingHook };

    await generateChapterBrief({
      input: onePageInput,
      plan,
      chapter: plan.chapters[0]!,
      chapterPageStart: 1,
      chapterPageEnd: 1,
      textModel: capture.model
    });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).not.toMatch(/second page has to answer/);
    expect(capture.system).toMatch(/Resolve the book's central promise/);
  });

  it("leaves a later chapter's brief unchanged", async () => {
    const capture = capturingJsonModel(briefResponse([20, 21], 2));

    await generateChapterBrief({
      input: chunkedInput,
      plan: chunkedPlan,
      chapter: chunkedPlan.chapters[chunkedPlan.chapters.length - 1]!,
      chapterPageStart: 20,
      chapterPageEnd: 21,
      textModel: capture.model
    });

    expect(capture.system).not.toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.payload?.openingHook).toBeUndefined();
  });

  it("assigns no openingHook to an imported manuscript's opening chapter", async () => {
    const capture = capturingJsonModel(briefResponse([1, 2, 3], 1));
    const importedChunkedInput: CreateProjectInput = { ...importedInput, targetPages: 40 };
    const plan: BookPlan = { ...makeFallbackPlan(importedChunkedInput), openingHook };

    await generateChapterBrief({
      input: importedChunkedInput,
      plan,
      chapter: plan.chapters[0]!,
      chapterPageStart: 1,
      chapterPageEnd: 3,
      textModel: capture.model
    });

    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.system).not.toContain(openingHook);
    expect(capture.payload?.openingHook).toBeUndefined();
    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
  });
});

describe("deterministic fallback page map opening beat", () => {
  it("assigns the openingHook in page 1's purpose instead of pasting its prose into the beat", async () => {
    const plan: BookPlan = { ...makeFallbackPlan(input), openingHook };

    const briefs = await generateWholeBookPageMap({ input, plan, textModel: failingModel });
    const pages = briefs.flatMap((brief) => brief.pages);
    const firstPage = pages.find((page) => page.pageIndex === 1);
    const secondPage = pages.find((page) => page.pageIndex === 2);

    expect(firstPage?.purpose).toMatch(/^Opening page of the book for /);
    expect(firstPage?.purpose).toMatch(/Deliver the plan's openingHook here/);
    // The hook reaches the writer as its own payload key beside this brief,
    // under an instruction to deliver it without echoing its wording. A copy of
    // its prose anywhere in the brief is the same words arriving a second time
    // as material to transform, so no field of page 1 may carry it.
    expect(JSON.stringify(firstPage)).not.toContain(openingHook);
    expect(firstPage?.endingPressure).toMatch(/second page must answer/);
    expect(secondPage?.purpose).not.toMatch(/openingHook/);
    expect(secondPage?.purpose).not.toMatch(/Opening page of the book/);
  });

  it("leaves page 1's purpose plain when the plan committed to no hook", async () => {
    const plan = makeFallbackPlan(input);

    const briefs = await generateWholeBookPageMap({ input, plan, textModel: failingModel });
    const firstPage = briefs.flatMap((brief) => brief.pages).find((page) => page.pageIndex === 1);

    expect(firstPage?.purpose).toMatch(/^Opening page of the book for /);
    expect(firstPage?.purpose).not.toMatch(/openingHook/);
  });

  it("leaves page 1's purpose plain on an imported manuscript, hook or no hook", async () => {
    // This path writes no prompt and has no payload key, so the condition is all
    // of the contract it can hold — and it has to be the same condition the four
    // prompt producers read, or the one book that reaches this fallback is the
    // one book whose author's opening gets reassigned.
    const plan: BookPlan = { ...makeFallbackPlan(importedInput), openingHook };

    const briefs = await generateWholeBookPageMap({ input: importedInput, plan, textModel: failingModel });
    const firstPage = briefs.flatMap((brief) => brief.pages).find((page) => page.pageIndex === 1);

    expect(firstPage?.purpose).toMatch(/^Opening page of the book for /);
    expect(firstPage?.purpose).not.toMatch(/openingHook/);
    expect(JSON.stringify(firstPage)).not.toContain(openingHook);
  });

  it("keeps the final-page resolution pressure ahead of the first-page rule on a one-page book", async () => {
    const onePageInput = { ...input, targetPages: 1 };
    const plan = makeFallbackPlan(onePageInput);

    const briefs = await generateWholeBookPageMap({ input: onePageInput, plan, textModel: failingModel });
    const firstPage = briefs.flatMap((brief) => brief.pages).find((page) => page.pageIndex === 1);

    expect(firstPage?.endingPressure).toMatch(/central promise/);
  });

  it("keeps the hand-off to chapter 2 when the first chapter is a single page", async () => {
    const fourPageInput = { ...input, targetPages: 4 };
    const basePlan = makeFallbackPlan(fourPageInput);
    // A one-page first chapter is the case where the two pressures collide: page
    // 1 owes the reader an opening tension, and it is also the only page that can
    // set up the chapter page 2 opens.
    const plan: BookPlan = {
      ...basePlan,
      chapters: [
        { ...basePlan.chapters[0]!, index: 1, title: "Chapter 1: The Wall", targetPages: 1 },
        { ...basePlan.chapters[0]!, index: 2, title: "Chapter 2: The Cost", targetPages: 3 }
      ]
    };

    const briefs = await generateWholeBookPageMap({ input: fourPageInput, plan, textModel: failingModel });
    const firstPage = briefs.flatMap((brief) => brief.pages).find((page) => page.pageIndex === 1);

    expect(firstPage?.endingPressure).toMatch(/second page must answer/);
    expect(firstPage?.endingPressure).toContain("Hand off cleanly toward Chapter 2: The Cost.");
  });
});

describe("page brief repair first-page contract", () => {
  const rejectedDraft = {
    title: "Welcome",
    markdown: "In this book we will explore what sacrifice means before we meet Jack at all.",
    summary: "The page frames the topic instead of opening it.",
    continuityNotes: []
  };

  const report: PageQualityReport = {
    approved: false,
    score: 41,
    issues: ["The opening restates the premise instead of entering the subject."],
    requiredRevisions: ["Open inside the concrete scene."],
    notes: "The assignment itself asks for framing.",
    groundedOk: true,
    unsupportedClaims: [],
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: false,
      progressionOk: false,
      styleNatural: true
    }
  };

  function repairOptions(pageIndex: number, plan: BookPlan) {
    return {
      input,
      plan,
      chapter: plan.chapters[0]!,
      pageIndex,
      pageBrief: {
        pageIndex,
        chapterIndex: 1,
        purpose: `Set up the book on page ${pageIndex}.`,
        beat: "Explain what the book is about before anything happens.",
        requiredContinuity: [],
        endingPressure: "The reader understands the topic."
      },
      draft: rejectedDraft,
      report,
      previousPages: [],
      continuityNotes: []
    };
  }

  it("restates the first-page rule and the openingHook when the repaired page is page 1", async () => {
    const capture = capturingJsonModel(modelPageBeat(1, 1));
    const plan: BookPlan = { ...makeFallbackPlan(input), openingHook };

    await repairPageBrief({ ...repairOptions(1, plan), textModel: capture.model });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/endingPressure must leave a specific tension/);
    expect(capture.system).toMatch(/openingHook is the plan's commitment/);
    expect(capture.payload?.openingHook).toBe(openingHook);
    // The repair's own landing-claim rule is not displaced by the amendment.
    expect(capture.system).toMatch(/substantive landing claim/);
  });

  it("repairs a one-page book's page 1 under the ending contract", async () => {
    const capture = capturingJsonModel(modelPageBeat(1, 1));
    const plan: BookPlan = { ...makeFallbackPlan(onePageInput), openingHook };

    await repairPageBrief({ ...repairOptions(1, plan), input: onePageInput, textModel: capture.model });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).not.toMatch(/second page has to answer/);
    expect(capture.system).toMatch(/Resolve the book's central promise/);
    // The repair's own landing-claim rule is still not displaced by either
    // reading of the amendment.
    expect(capture.system).toMatch(/substantive landing claim/);
  });

  it("leaves a later page's repair unchanged", async () => {
    const capture = capturingJsonModel(modelPageBeat(2, 1));
    const plan: BookPlan = { ...makeFallbackPlan(input), openingHook };

    await repairPageBrief({ ...repairOptions(2, plan), textModel: capture.model });

    expect(capture.system).not.toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.payload?.openingHook).toBeUndefined();
    expect(capture.system).toContain("Discard source-identity requirements from the original page brief");
    expect(capture.payload?.researchNotes).toEqual([]);
  });

  it("preserves source-identity requirements when a citeable note can satisfy them", async () => {
    const capture = capturingJsonModel(modelPageBeat(2, 1));
    const plan: BookPlan = {
      ...makeFallbackPlan(input),
      researchNotes: [
        {
          query: "archive",
          title: "Boundary papers",
          url: "https://example.com/papers",
          summary: "Commission records."
        }
      ]
    };

    await repairPageBrief({ ...repairOptions(2, plan), textModel: capture.model });

    expect(capture.system).not.toContain("Discard source-identity requirements from the original page brief");
    expect(capture.payload?.researchNotes).toHaveLength(1);
  });

  it("keeps the first-page rule but sends no openingHook when the plan has none", async () => {
    const capture = capturingJsonModel(modelPageBeat(1, 1));
    const plan = makeFallbackPlan(input);

    await repairPageBrief({ ...repairOptions(1, plan), textModel: capture.model });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.payload?.openingHook).toBeUndefined();
  });

  it("restates no openingHook when the repaired page 1 belongs to an imported manuscript", async () => {
    // The repair is the producer that rewrites whichever of the others wrote the
    // brief, so it is the one that reaches page 1 after a QA failure with some
    // entirely unrelated cause — the same shape as the reviser incident on the
    // prompt side.
    const capture = capturingJsonModel(modelPageBeat(1, 1));
    const plan: BookPlan = { ...makeFallbackPlan(importedInput), openingHook };

    await repairPageBrief({ ...repairOptions(1, plan), input: importedInput, textModel: capture.model });

    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.system).not.toContain(openingHook);
    expect(capture.payload?.openingHook).toBeUndefined();
    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
  });

  it("repairs at the shared rewrite ceiling, and a cooler book at its own temperature", async () => {
    // The ceiling is one constant, read here rather than restated: this and
    // `polishPageDraft`'s clamp (pagesPolish.test.ts) used to be independent
    // 0.65 literals under a comment asserting they were the same number, so
    // moving it moved only the polish path.
    const plan: BookPlan = { ...makeFallbackPlan(input), openingHook };
    const hot = capturingJsonModel(modelPageBeat(1, 1));

    await repairPageBrief({ ...repairOptions(1, plan), textModel: hot.model });

    expect(input.temperature).toBeGreaterThan(REWRITE_TEMPERATURE_CEILING);
    expect(hot.temperature).toBeCloseTo(REWRITE_TEMPERATURE_CEILING, 10);

    const coolInput: CreateProjectInput = { ...input, temperature: REWRITE_TEMPERATURE_CEILING - 0.1 };
    const cool = capturingJsonModel(modelPageBeat(1, 1));

    await repairPageBrief({ ...repairOptions(1, plan), input: coolInput, textModel: cool.model });

    expect(cool.temperature).toBeCloseTo(coolInput.temperature, 10);
  });
});
