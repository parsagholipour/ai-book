import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { CONTINUITY_NOTE_PROMPT_LIMITS } from "../context/contextPack.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput, PageQualityReport } from "../schemas/book.js";
import { revisePageDraft, reviewPageDraft, runFinalBookQa } from "./pagesReview.js";
import { GROUNDED_FACTUALITY_RULE } from "./pagesShared.js";
import { SMART_UNSLOP_ISSUE_PREFIX } from "./smartUnslop.js";

const input: CreateProjectInput = {
  prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
  category: "STORY",
  targetPages: 10,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral" as const
  }
};

/**
 * The provenance an imported manuscript carries — `mediaSettings.mobile.import`,
 * written by the import route and carried through `planInputSnapshot` into the
 * plan version's input snapshot, which is what `compileExport` rebuilds `input`
 * from before it runs final QA. Only that record separates it from `input`.
 */
const importedInput: CreateProjectInput = {
  ...input,
  mediaSettings: {
    ...input.mediaSettings,
    mobile: { bookType: "custom", import: { importId: "imp_1", fileName: "chapel.docx", format: "docx" } }
  }
};

const plan = makeFallbackPlan(input);

function goodMarkdown(): string {
  return [
    "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble before anyone touched it from the other side.",
    "",
    '"You promised you would wait," Mara said from the stairwell.',
    "",
    "Jack did not turn. The folded warrant in his coat had already warmed against his ribs, and the red wax seal had cracked where his thumb kept worrying it. Inside the chapel, someone dragged a chair across stone. That small sound decided him. He lifted the latch, stepped through, and let Mara see the scar over his left eyebrow catch the candlelight."
  ].join("\n");
}

/**
 * A page-1 draft long enough to have overrun the old 4,000-character opening
 * cap. `goodMarkdown` is ~700 characters, so the padding is what carries it
 * past both the old ceiling and the new one.
 */
function paddedOpening(minLength: number): string {
  const parts = [goodMarkdown()];
  let entry = 0;
  while (parts.join("\n\n").length < minLength) {
    entry += 1;
    parts.push(
      `The clerk wrote entry ${entry} into the parish ledger, pressed the blotter flat over the ink, and counted ${entry + 4} coins back into the tin before he let himself look at the chapel door again.`
    );
  }
  return parts.join("\n\n");
}

function capturingReviewModel(rawData: unknown): {
  model: TextModelAdapter;
  payload?: Record<string, unknown>;
  system?: string;
} {
  const capture: { model: TextModelAdapter; payload?: Record<string, unknown>; system?: string } = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.system = options.messages[0]?.content ?? "";
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
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

describe("reviewPageDraft recency window", () => {
  it("keeps a 5-page recency window of 800-character excerpts", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 92,
      issues: [],
      requiredRevisions: [],
      notes: "Approved.",
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    });
    const previousPages = Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      title: `Prior ${index + 1}`,
      markdown: `page-${index + 1} ${"x".repeat(1200)}`,
      summary: `Summary ${index + 1}`
    }));

    await reviewPageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 7,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and commits to a dangerous choice.",
        continuityNotes: []
      },
      previousPages,
      continuityNotes: [],
      textModel: capture.model
    });

    const compacted = capture.payload?.previousPages as Array<{ index: number; excerpt: string }>;
    expect(compacted.map((page) => page.index)).toEqual([2, 3, 4, 5, 6]);
    expect(compacted.every((page) => page.excerpt.length === 800)).toBe(true);
  });

  it("compacts context to adjacent continuity while preserving the page brief and page scope", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 92,
      issues: [],
      requiredRevisions: [],
      notes: "Approved.",
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    });
    const previousPages = Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      title: `Prior ${index + 1}`,
      markdown: `page-${index + 1} ${"x".repeat(1200)}`,
      summary: `Summary ${index + 1}`
    }));
    const currentBrief = {
      pageIndex: 7,
      chapterIndex: 2,
      purpose: "Force the irreversible choice.",
      beat: "Jack signs the warrant in Mara's presence.",
      requiredContinuity: ["The seal is already cracked."],
      endingPressure: "The chapel bell exposes them."
    };
    const chapterBrief = {
      chapterIndex: 2,
      title: "The Warrant",
      summary: "Jack chooses which promise to break.",
      continuityFocus: ["The warrant stays visible."],
      pages: [
        { ...currentBrief, pageIndex: 6, purpose: "Set the choice.", beat: "Mara arrives." },
        currentBrief,
        { ...currentBrief, pageIndex: 8, purpose: "Pay the cost.", beat: "The guard enters." },
        { ...currentBrief, pageIndex: 9, purpose: "Close the chapter.", beat: "Jack loses the key." }
      ]
    };

    await reviewPageDraft({
      input,
      plan,
      chapter: { index: 2, title: "The Warrant", summary: "A costly choice.", targetPages: 4, keyBeats: ["A very long duplicated chapter beat."] },
      chapterBrief,
      pageBrief: currentBrief,
      chapterPageStart: 6,
      chapterPageEnd: 9,
      pageIndex: 7,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack signs and the bell rings.",
        continuityNotes: []
      },
      previousPages,
      nextPages: [{ index: 8, title: "The Guard", markdown: `guard ${"y".repeat(1200)}`, summary: "The guard enters." }],
      continuityNotes: Array.from({ length: 12 }, (_, index) => `Continuity ${index + 1}`),
      textModel: capture.model,
      pageReviewPromptMode: "compact"
    });

    expect(capture.payload?.pageBrief).toEqual(currentBrief);
    expect(capture.payload?.pageScope).toMatchObject({
      globalPageIndex: 7,
      totalBookPages: 10,
      chapterPageStart: 6,
      chapterPageEnd: 9,
      chapterPageNumber: 2,
      chapterPageCount: 4,
      isFirstPageOfChapter: false,
      isLastPageOfChapter: false
    });
    expect(capture.payload?.previousPages).toEqual([
      expect.objectContaining({ index: 6, summary: "Summary 6" })
    ]);
    expect(capture.payload?.followingPages).toEqual([
      expect.objectContaining({ index: 8, summary: "The guard enters." })
    ]);
    expect(((capture.payload?.previousPages ?? []) as Array<{ excerpt: string }>)[0]?.excerpt.length)
      .toBeLessThanOrEqual(450);
    expect(((capture.payload?.followingPages ?? []) as Array<{ excerpt: string }>)[0]?.excerpt.length)
      .toBeLessThanOrEqual(450);
    expect(capture.payload?.continuityNotes).toEqual([
      "Continuity 7",
      "Continuity 8",
      "Continuity 9",
      "Continuity 10",
      "Continuity 11",
      "Continuity 12"
    ]);
    expect(capture.payload?.chapter).not.toHaveProperty("keyBeats");
    const scope = capture.payload?.pageScope as {
      previousChapterPageBriefs: unknown[];
      futureChapterPageBriefs: Array<{ pageIndex: number; reservedBeat: string }>;
    };
    expect(scope.previousChapterPageBriefs).toHaveLength(1);
    expect(scope.futureChapterPageBriefs).toEqual([
      { pageIndex: 8, reservedBeat: "Pay the cost. — The guard enters. — The chapel bell exposes them." },
      { pageIndex: 9, reservedBeat: "Close the chapter. — Jack loses the key. — The chapel bell exposes them." }
    ]);
  });

  it("keeps opening and final-page contracts in compact mode", async () => {
    const onePageInput = { ...input, targetPages: 1 };
    const onePagePlan = makeFallbackPlan(onePageInput);
    const capture = capturingReviewModel({
      approved: true,
      score: 92,
      issues: [],
      requiredRevisions: [],
      notes: "Approved.",
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    });

    await reviewPageDraft({
      input: onePageInput,
      plan: onePagePlan,
      pageIndex: 1,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and completes his choice.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model,
      pageReviewPromptMode: "compact"
    });

    expect(capture.system).toContain("throat-clearing");
    expect(capture.system).toContain("For a final page");
    expect(capture.payload?.openingHook).toBe(onePagePlan.openingHook);
    expect(capture.payload?.pageScope).toMatchObject({
      globalPageIndex: 1,
      totalBookPages: 1
    });
  });
});

describe("reviewPageDraft local-check policy", () => {
  it("skips a local adjacent-contrast rejection while still calling the model reviewer", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 92,
      issues: [],
      requiredRevisions: [],
      notes: "Approved.",
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    });
    const result = await reviewPageDraft({
      input,
      plan,
      pageIndex: 7,
      draft: {
        title: "The Reversal",
        markdown: "You have been taught that the argument is settled. But what if the original pattern reveals the opposite: a hidden primacy and a hierarchy visible only when the old reading is overturned? A careful account then tests the words, the context, and the rival explanation before reaching its conclusion.",
        summary: "The page tests a familiar argument against its original context.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model,
      skipLocalChecks: true
    });

    expect(capture.payload).toBeDefined();
    expect(result.approved).toBe(true);
  });

  it("keeps the provenance-only opening invariant when configurable local checks are skipped", async () => {
    const approved = {
      approved: true,
      score: 92,
      issues: [],
      requiredRevisions: [],
      notes: "Approved.",
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    };
    const weakOpening = {
      title: "August Water",
      markdown: "Have you ever wondered why your tap water tastes different in August? The treatment works sits above the town, where the duty engineer records the reservoir temperature and adjusts the intake before the morning supply begins its journey downhill.",
      summary: "The narrator begins investigating the town's changing summer water.",
      continuityNotes: []
    };
    const generated = capturingReviewModel(approved);

    const generatedReport = await reviewPageDraft({
      input,
      plan,
      pageIndex: 1,
      draft: weakOpening,
      previousPages: [],
      continuityNotes: [],
      textModel: generated.model,
      skipLocalChecks: true
    });

    expect(generatedReport.approved).toBe(false);
    expect(generatedReport.issues).toContain(
      "First page opens with a generic or meta hook instead of a concrete one."
    );
    expect(generated.payload).toBeUndefined();

    const imported = capturingReviewModel(approved);
    const importedReport = await reviewPageDraft({
      input: importedInput,
      plan,
      pageIndex: 1,
      draft: weakOpening,
      previousPages: [],
      continuityNotes: [],
      textModel: imported.model,
      skipLocalChecks: true
    });

    expect(importedReport.approved).toBe(true);
    expect(imported.payload).toBeDefined();
  });
});

describe("reviewPageDraft writer contracts", () => {
  it("does not send voiceGuide; that is a writer assignment", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 92,
      issues: [],
      requiredRevisions: [],
      notes: "Approved.",
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    });

    await reviewPageDraft({
      input,
      plan: {
        ...plan,
        voiceGuide: [
          "Begin chapters with a specific documented moment, place, decision, or testimony, then widen the lens."
        ]
      },
      chapter: plan.chapters[0],
      pageIndex: 7,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and commits to a dangerous choice.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    expect(JSON.stringify(capture.payload)).not.toMatch(/"voiceGuide"/);
    expect(JSON.stringify(capture.payload)).not.toMatch(/documented moment/);
  });
});

describe("reviewPageDraft continuity notes", () => {
  it("keeps the end of the producer's ranking when the full budget overflows the prompt", async () => {
    const capture = capturingReviewModel({
      approved: true,
      score: 92,
      issues: [],
      requiredRevisions: [],
      notes: "Approved.",
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      }
    });
    // `loadContinuityNotes` hands over its whole budget ranked ascending, so
    // the last entry is the best-scoring trigram hit about this page's own
    // cast. This prompt keeps fewer than that budget, and it used to keep the
    // wrong end: `slice(-20)` of a descending ranking dropped exactly the
    // eight hits the relevance arm exists to surface.
    const topHit = "Tomas still guards the vault, and the brass key opens it.";
    const continuityNotes = [
      ...Array.from({ length: CONTINUITY_NOTE_PROMPT_LIMITS.draft - 1 }, (_, index) => `Recency note ${index}.`),
      topHit
    ];

    await reviewPageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 7,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and commits to a dangerous choice.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes,
      textModel: capture.model
    });

    const sent = capture.payload?.continuityNotes as string[];
    expect(sent).toHaveLength(CONTINUITY_NOTE_PROMPT_LIMITS.review);
    expect(sent.at(-1)).toBe(topHit);
    expect(sent[0]).toBe(`Recency note ${CONTINUITY_NOTE_PROMPT_LIMITS.draft - CONTINUITY_NOTE_PROMPT_LIMITS.review}.`);
  });
});

describe("reviewPageDraft first-page rule", () => {
  const approvedReport = {
    approved: true,
    score: 92,
    issues: [],
    requiredRevisions: [],
    notes: "Approved.",
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: true,
      progressionOk: true,
      styleNatural: true
    }
  };

  function capturingReviewModelWithSystem(rawData: unknown): {
    model: TextModelAdapter;
    payload?: Record<string, unknown>;
    systemPrompt?: string;
  } {
    const capture: { model: TextModelAdapter; payload?: Record<string, unknown>; systemPrompt?: string } = {
      model: {
        async generateText() {
          return { text: "", model: "test-model", provider: "test" };
        },
        async generateJson(options) {
          capture.systemPrompt = options.messages[0]?.content ?? "";
          capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
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

  it("tells the reviewer to reject throat-clearing first pages and hands it the plan's openingHook", async () => {
    const capture = capturingReviewModelWithSystem(approvedReport);
    const hookPlan = { ...plan, openingHook: "Jack is mid-climb over the chapel wall when the bell starts." };

    await reviewPageDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    expect(capture.systemPrompt).toMatch(/first page, reject throat-clearing or meta openings/i);
    expect(capture.payload?.openingHook).toBe(hookPlan.openingHook);

    await reviewPageDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 7,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and commits to a dangerous choice.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    expect(capture.payload?.openingHook).toBeUndefined();
  });

  it("hands final book QA the book's opening page as written", async () => {
    const capture = capturingReviewModelWithSystem({
      approved: true,
      score: 92,
      issues: [],
      requiredFixes: [],
      notes: "Approved."
    });
    const qaInput = { ...input, targetPages: 2 };
    const pages = [
      {
        index: 1,
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts ringing across the courtyard."
      },
      {
        index: 2,
        title: "The Ledger Room",
        markdown: [
          "The ledger room smelled of tallow and wet wool. Mara spread the parish accounts across the table and set a candle at each corner so the columns would not swim.",
          "",
          "Jack read the entries twice. Somebody had paid the bell-ringer a full week's wage on a night the tower was supposed to be empty, and the signature under the payment was the priest's — dated two days after the priest had left for the coast. Mara circled it without a word and slid the page across the table toward him."
        ].join("\n"),
        summary: "Mara finds a payment in the parish accounts that the absent priest could not have signed."
      }
    ];

    await runFinalBookQa({
      input: qaInput,
      plan,
      pages,
      textModel: capture.model
    });

    expect(capture.systemPrompt).toMatch(/openingPages carries the book's first page as written/i);
    const openingPages = capture.payload?.openingPages as Array<{ index: number; markdown: string }>;
    expect(openingPages.map((page) => page.index)).toEqual([1]);
    expect(openingPages[0]?.markdown).toBe(goodMarkdown());
    expect(capture.payload?.instruction).toMatch(/openingPages is the book's first page as written/i);
  });

  const ledgerPage = {
    index: 2,
    title: "The Ledger Room",
    markdown: [
      "The ledger room smelled of tallow and wet wool. Mara spread the parish accounts across the table and set a candle at each corner so the columns would not swim.",
      "",
      "Jack read the entries twice. Somebody had paid the bell-ringer a full week's wage on a night the tower was supposed to be empty, and the signature under the payment was the priest's — dated two days after the priest had left for the coast. Mara circled it without a word and slid the page across the table toward him."
    ].join("\n"),
    summary: "Mara finds a payment in the parish accounts that the absent priest could not have signed."
  };

  const approvedFinalQa = { approved: true, score: 92, issues: [], requiredFixes: [], notes: "Approved." };

  it("keeps page 2 out of openingPages, because only page 1 can be repaired from an opening verdict", async () => {
    // "The second page repeats the first page's opening image" carries no
    // digit, so the repair pass finds no page number and its opening heuristic
    // adds index 1: page 2 is never redrafted, the repair changes nothing, and
    // the next final QA rejects the same book again. The reviewer is therefore
    // shown only the page a rejection can act on - page 2 stays in the pageMap,
    // whose rows carry their own index for a complaint to name.
    const capture = capturingReviewModelWithSystem(approvedFinalQa);

    await runFinalBookQa({
      input: { ...input, targetPages: 2 },
      plan,
      pages: [
        {
          index: 1,
          title: "The Wall Bell",
          markdown: goodMarkdown(),
          summary: "Jack is caught mid-climb when the chapel bell starts ringing across the courtyard."
        },
        ledgerPage
      ],
      textModel: capture.model
    });

    expect(JSON.stringify(capture.payload?.openingPages)).not.toContain("ledger room");
    const pageMap = capture.payload?.pageMap as Array<{ index: number }>;
    expect(pageMap.map((page) => page.index)).toEqual([1, 2]);
    // The rule, the instruction and the payload have to agree, or the reviewer
    // is invited to place a complaint the repair pass cannot follow.
    expect(capture.systemPrompt).toMatch(/give any other page's issue the page number pageMap records/i);
    expect(capture.payload?.instruction).toMatch(/only page an opening verdict is about/i);
  });

  it("sends a dense opening page whole rather than cutting it mid-sentence", async () => {
    // The cap was 4,000 characters while the prompt called the excerpt the
    // full opening, so a complexity-9 page 1 arrived stopping mid-sentence and
    // the reviewer rejected the book for an opening the book does not have.
    const capture = capturingReviewModelWithSystem(approvedFinalQa);
    const opening = paddedOpening(9_000);
    expect(opening.length).toBeGreaterThan(4_000);

    await runFinalBookQa({
      input: { ...input, targetPages: 2 },
      plan,
      pages: [
        {
          index: 1,
          title: "The Wall Bell",
          markdown: opening,
          summary: "Jack is caught mid-climb when the chapel bell starts ringing across the courtyard."
        },
        ledgerPage
      ],
      textModel: capture.model
    });

    const openingPages = capture.payload?.openingPages as Array<{ index: number; markdown: string }>;
    expect(openingPages[0]?.markdown).toBe(opening);
    expect(openingPages[0]?.markdown).not.toContain("…");
  });

  /**
   * A weak first page whose author is the reader: the exact sentence
   * `hasWeakFirstPageOpening` (pagesLocalQa.ts) rejects, long enough to clear
   * every other local gate so the only thing that can stop it is the opening
   * rule.
   */
  const authorsOpeningPage = {
    index: 1,
    title: "August Water",
    markdown: [
      "Have you ever wondered why your tap water tastes different in August? I did, for eleven summers, before I finally carried a jar of it up the hill to the treatment works and asked the duty engineer to explain himself over a cup of tea.",
      "",
      "He put the jar on the windowsill where the light could get at it, told me the reservoir turns over in the heat, and then drew the whole business on the back of a delivery note: the intake, the settling tanks, the contact time that decides how much chlorine survives the trip to my kitchen. It took him nine minutes and I have never tasted the water the same way since."
    ].join("\n"),
    summary: "The author carries a jar of August tap water to the treatment works and gets the reservoir explained."
  };

  it("leaves an imported manuscript's opening to its author, in the payload and in the rule text", async () => {
    // The control first: in a generated book the local gate rejects this page
    // and `runFinalBookQa` returns before the model is ever called. That early
    // return is what the import exemption removes - so an exemption spelled
    // only in the local gate handed the author's first sentence to a reviewer
    // instructed to reject it, and a pageless opening verdict is filed against
    // page 1 by `extractRepairPageIndexes`, which model-rewrites that line.
    const generated = capturingReviewModelWithSystem(approvedFinalQa);
    const generatedReport = await runFinalBookQa({
      input: { ...input, targetPages: 2 },
      plan,
      pages: [authorsOpeningPage, ledgerPage],
      textModel: generated.model
    });

    expect(generatedReport.approved).toBe(false);
    expect(generated.systemPrompt).toBeUndefined();

    const imported = capturingReviewModelWithSystem(approvedFinalQa);
    const importedReport = await runFinalBookQa({
      input: { ...importedInput, targetPages: 2 },
      plan,
      pages: [authorsOpeningPage, ledgerPage],
      textModel: imported.model
    });

    // The import reaches the model call - that is the whole hazard - and the
    // model is given neither the rule nor the prose to apply it to.
    expect(importedReport.approved).toBe(true);
    expect(imported.systemPrompt).toBeDefined();
    expect(imported.systemPrompt).not.toMatch(/reject the book when the opening is meta/i);
    expect(imported.systemPrompt).not.toMatch(/openingPages/);
    expect(imported.payload?.openingPages).toBeUndefined();
    expect(JSON.stringify(imported.payload)).not.toContain("Have you ever wondered");
    // What the opening rule carried for every other page still has to be said.
    expect(imported.systemPrompt).toMatch(/give every issue the page number pageMap records/i);
    expect(imported.payload?.instruction).toMatch(/Give every issue the page number pageMap records/);
  });

  it("keeps the provenance-only opening invariant when configurable final local QA is skipped", async () => {
    const generated = capturingReviewModelWithSystem(approvedFinalQa);
    const generatedReport = await runFinalBookQa({
      input: { ...input, targetPages: 2 },
      plan,
      pages: [authorsOpeningPage, ledgerPage],
      textModel: generated.model,
      skipLocalChecks: true
    });

    expect(generatedReport.approved).toBe(false);
    expect(generatedReport.issues).toContain(
      "Page 1: First page opens with a generic or meta hook instead of a concrete one."
    );
    expect(generated.systemPrompt).toBeUndefined();

    const imported = capturingReviewModelWithSystem(approvedFinalQa);
    const importedReport = await runFinalBookQa({
      input: { ...importedInput, targetPages: 2 },
      plan,
      pages: [authorsOpeningPage, ledgerPage],
      textModel: imported.model,
      skipLocalChecks: true
    });

    expect(importedReport.approved).toBe(true);
    expect(imported.systemPrompt).toBeDefined();
  });

  it("drops the first-page opening rule for an imported manuscript's page-1 repair", async () => {
    // The page reviewer has the same fork: a repair redrafts page 1 and this
    // reviewer judges the result, so an import that reached the repair pass at
    // all was judged against a rule its author was never given.
    const generated = capturingReviewModelWithSystem(approvedReport);
    await reviewPageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: generated.model
    });

    expect(generated.systemPrompt).toMatch(/first page, reject throat-clearing or meta openings/i);

    const imported = capturingReviewModelWithSystem(approvedReport);
    await reviewPageDraft({
      input: importedInput,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: imported.model
    });

    expect(imported.systemPrompt).toBeDefined();
    expect(imported.systemPrompt).not.toMatch(/first page, reject throat-clearing or meta openings/i);
  });

  it("names the openingHook it hands the reviewer, as delivery rather than echo", async () => {
    // The payload key shipped with no rule naming it, next to pageBrief - and
    // the natural reading of an unlabelled field ("the page must match it")
    // contradicts what `buildPageInstruction` tells the writer, which is to
    // deliver the hook "without echoing its wording". A correctly transformed
    // page 1 could be rejected for not reproducing it.
    const hookPlan = { ...plan, openingHook: "Jack is mid-climb over the chapel wall when the bell starts." };
    const capture = capturingReviewModelWithSystem(approvedReport);

    await reviewPageDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    expect(capture.payload?.openingHook).toBe(hookPlan.openingHook);
    expect(capture.systemPrompt).toMatch(/openingHook is the plan's commitment to how this book opens/i);
    expect(capture.systemPrompt).toMatch(/never require it to reproduce, quote, or echo the hook's wording/i);

    await reviewPageDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 7,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and commits to a dangerous choice.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    // The rule and the key leave together, so no page is shown one without the
    // other.
    expect(capture.payload?.openingHook).toBeUndefined();
    expect(capture.systemPrompt).not.toMatch(/openingHook/);
  });

  it("names no openingHook to the reviewer or the reviser on an imported manuscript's page 1", async () => {
    // The hook rides the import exemption for the reason this pair makes
    // visible. A fresh import's plan has no `openingHook` at all
    // (`synthesizeImportedBookPlan`); one appears only when a later replan
    // invents it from the premise, having never read page 1. Told to judge
    // whether page 1 delivers it, this reviewer rejects the author's own opening
    // - and the only repair for that verdict is `revisePageDraft`, which was
    // being handed the same invented hook as an instruction to rewrite the
    // author's sentence into it.
    const hookPlan = { ...plan, openingHook: "Jack is mid-climb over the chapel wall when the bell starts." };
    const review = capturingReviewModelWithSystem(approvedReport);

    await reviewPageDraft({
      input: importedInput,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: review.model
    });

    expect(review.systemPrompt).toBeDefined();
    expect(review.systemPrompt).not.toMatch(/openingHook/);
    expect(review.payload?.openingHook).toBeUndefined();
    expect(JSON.stringify(review.payload)).not.toContain(hookPlan.openingHook);

    const revise = capturingReviewModelWithSystem({
      title: "The Wall Bell",
      markdown: goodMarkdown(),
      summary: "Jack is caught mid-climb when the chapel bell starts.",
      continuityNotes: []
    });

    await revisePageDraft({
      input: importedInput,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      // The failure that reaches page 1 of an import is never about its opening:
      // the opening rule is silenced for it in both reviewers, so what lands
      // here is repetition, a prompt leak, or a reader's own edit request.
      report: {
        ...approvedReport,
        approved: false,
        score: 40,
        issues: ["Repeats a phrase from page 3."],
        requiredRevisions: ["Replace the repeated phrasing."],
        groundedOk: true,
        unsupportedClaims: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: revise.model
    });

    expect(revise.payload?.openingHook).toBeUndefined();
    expect(String(revise.payload?.instruction)).not.toMatch(/openingHook/);
    expect(JSON.stringify(revise.payload)).not.toContain(hookPlan.openingHook);
  });

  it("marks an opening page it still has to shorten, and says the marker is not a defect", async () => {
    const capture = capturingReviewModelWithSystem(approvedFinalQa);
    const opening = paddedOpening(20_000);

    await runFinalBookQa({
      input: { ...input, targetPages: 2 },
      plan,
      pages: [
        {
          index: 1,
          title: "The Wall Bell",
          markdown: opening,
          summary: "Jack is caught mid-climb when the chapel bell starts ringing across the courtyard."
        },
        ledgerPage
      ],
      textModel: capture.model
    });

    const openingPages = capture.payload?.openingPages as Array<{ index: number; markdown: string }>;
    expect(openingPages[0]?.markdown.length).toBeLessThanOrEqual(14_000);
    expect(openingPages[0]?.markdown.endsWith("…")).toBe(true);
    // The cut is only survivable because both prompts name it, the way they
    // already name the pageMap's own shortening.
    expect(capture.systemPrompt).toMatch(/openingPages excerpt ends with an ellipsis/i);
    expect(capture.payload?.instruction).toMatch(/openingPages excerpts may end with …/);
  });
});

describe("revisePageDraft first-page hook", () => {
  const rejection: PageQualityReport = {
    approved: false,
    score: 45,
    issues: ["First page opens with a generic or meta hook instead of a concrete one."],
    requiredRevisions: ["Open inside the scene the plan commits to."],
    notes: "Local quality checks rejected the page.",
    groundedOk: true,
    unsupportedClaims: [],
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: true,
      progressionOk: true,
      styleNatural: false
    }
  };

  function reviseOptions(pageIndex: number, hookPlan: typeof plan, textModel: TextModelAdapter) {
    return {
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      report: rejection,
      previousPages: [],
      continuityNotes: [],
      textModel
    };
  }

  it("hands the reviser the openingHook its own instruction names, on page 1 only", async () => {
    // `buildPageInstruction` tells the writer to deliver "the plan's
    // openingHook". The revision payload carried no such key, so the rewrite
    // of the page most likely to need the hook was pointed at nothing.
    const hookPlan = { ...plan, openingHook: "Jack is mid-climb over the chapel wall when the bell starts." };
    const capture = capturingReviewModel({
      title: "The Wall Bell",
      markdown: goodMarkdown(),
      summary: "Jack is caught mid-climb when the chapel bell starts.",
      continuityNotes: []
    });

    await revisePageDraft(reviseOptions(1, hookPlan, capture.model));

    expect(capture.payload?.openingHook).toBe(hookPlan.openingHook);
    expect(capture.payload?.instruction).toMatch(/openingHook/);
    expect(capture.system).toContain(GROUNDED_FACTUALITY_RULE);
    expect(capture.payload?.instruction).toContain(GROUNDED_FACTUALITY_RULE);

    await revisePageDraft(reviseOptions(7, hookPlan, capture.model));

    expect(capture.payload?.openingHook).toBeUndefined();
  });
});

describe("revisePageDraft conditional Smart unslop", () => {
  it("does not inject Smart unslop instructions for another quality gate", async () => {
    const draft = {
      title: "The Wall Bell",
      markdown: goodMarkdown(),
      summary: "Jack crosses the threshold and commits to a dangerous choice.",
      continuityNotes: [] as string[]
    };
    const capture = capturingReviewModel(draft);
    const report: PageQualityReport = {
      approved: false,
      score: 45,
      issues: ["The page repeats a beat already covered on page 3."],
      requiredRevisions: ["Replace the repeated beat with new progression."],
      notes: "The repetition quality gate rejected the page.",
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

    await revisePageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 4,
      draft,
      report,
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    expect(capture.system).not.toMatch(/Smart unslop findings/i);
    expect(capture.system).not.toMatch(/scanner candidates, not confirmed defects/i);
    expect(capture.system).not.toMatch(/copy rejectedDraft to the output exactly/i);
    expect(capture.system).not.toMatch(/every other sentence byte-for-byte/i);
  });

  it("treats deterministic matches as candidates and permits an exact no-op", async () => {
    const draft = {
      title: "The Wall Bell",
      markdown: goodMarkdown(),
      summary: "Jack crosses the threshold and commits to a dangerous choice.",
      continuityNotes: [] as string[]
    };
    const capture = capturingReviewModel(draft);
    const report: PageQualityReport = {
      approved: false,
      score: 70,
      issues: [`${SMART_UNSLOP_ISSUE_PREFIX} found three possible signals.`],
      requiredRevisions: ["Inspect the deterministic candidates in context."],
      notes: "Candidate review requested.",
      groundedOk: true,
      unsupportedClaims: [],
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: false
      }
    };

    const revised = await revisePageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 4,
      draft,
      report,
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    expect(capture.system).toMatch(/scanner candidates, not confirmed defects and not authorization to edit/i);
    expect(capture.system).toMatch(/copy rejectedDraft to the output exactly/i);
    expect(capture.system).toMatch(/every other sentence byte-for-byte/i);
    expect(revised).toEqual(draft);
  });
});
