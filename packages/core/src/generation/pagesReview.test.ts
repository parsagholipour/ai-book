import { describe, expect, it } from "vitest";
import { CONTINUITY_NOTE_PROMPT_LIMITS } from "../context/contextPack.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { PageQualityReport } from "../schemas/book.js";
import { revisePageDraft, reviewPageDraft } from "./pagesReview.js";
import { SMART_UNSLOP_ISSUE_PREFIX } from "./smartUnslop.js";
import { input, importedInput, plan, goodMarkdown, capturingReviewModel } from "./testing/pagesReviewFixtures.js";

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
