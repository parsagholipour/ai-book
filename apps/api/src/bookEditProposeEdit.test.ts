import { describe, expect, it } from "vitest";
import { intentFromDecideAction, intentFromProposeEdit } from "./bookEditIntent.js";
import { classifyWithDegradedHeuristics } from "./bookEditHeuristics.js";
import { bookPageMapForProject, readerPageNumbering } from "./bookPageNumbering.js";
import { type DecideActionPayload } from "./bookEditRouterPrompt.js";

/**
 * The router's `propose_edit` decision mapped onto a priced intent kind, and the
 * model-free fallback that has to reach the same answer when the router is
 * unavailable. Split from bookEditIntent.test.ts, which covers the classifier
 * itself and its clarification budget.
 */

const pages = [
  {
    id: "page-1",
    index: 1,
    title: "Opening",
    summary: "Rabbit brags before the race.",
    previewText: "Rabbit hops to the starting line while Turtle smiles."
  },
  {
    id: "page-2",
    index: 2,
    title: "Practice",
    summary: "Turtle keeps moving.",
    previewText: "The old phrase appears in the practice scene."
  }
];

const chapters = [
  { index: 1, title: "The Race Begins", pageIndexes: [1] },
  { index: 2, title: "Steady Wins", pageIndexes: [2] }
];

describe("propose_edit pricing mapping", () => {
  it("maps exact page replacements to local_patch", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Exact replacement.",
        assistantMessage: "I’ll replace that phrase on page 1.",
        clarification: "none",
        editTarget: "pages",
        editStyle: "exact_replace",
        pageIndexes: [1],
        chapterIndex: null,
        targetLanguage: null
      },
      'On page 1, replace "old" with "new".',
      chapters
    );

    expect(intent.kind).toBe("local_patch");
    expect(intent.scope).toBe("explicit_pages");
    expect(intent.impact).toBe("small_text");
  });

  it("maps whole-book rewrites to page_rewrite", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Whole-book style.",
        assistantMessage: "I’ll rewrite the whole book warmer.",
        clarification: "none",
        editTarget: "whole_book",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "Make the whole book warmer.",
      chapters
    );

    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("all_pages");
  });

  it("maps chapter targets to chapter_regenerate", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Chapter rewrite.",
        assistantMessage: "I’ll rewrite chapter 2.",
        clarification: "none",
        editTarget: "chapter",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: 2,
        targetLanguage: null
      },
      "Rewrite chapter 2.",
      chapters
    );

    expect(intent.kind).toBe("chapter_regenerate");
    expect(intent.affectedChapterIndex).toBe(2);
    expect(intent.affectedPageIndexes).toEqual([2]);
  });

  it("maps structural and language_copy targets to book_replan", () => {
    const structural = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Identity change.",
        assistantMessage: "I’ll rebuild around a new protagonist.",
        clarification: "none",
        editTarget: "structural",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "Change the main character.",
      chapters
    );
    expect(structural.kind).toBe("book_replan");

    const language = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Language copy.",
        assistantMessage: "I’ll create an English copy.",
        clarification: "none",
        editTarget: "language_copy",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: "en"
      },
      "Generate the English version",
      chapters
    );
    expect(language.kind).toBe("book_replan");
    expect(language.targetLanguage).toBe("en");
  });

  it("carries the length and image settings a structural request named", () => {
    const intent = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.8,
        reasoning: "The user wants a shorter book with no pictures.",
        assistantMessage: "I’ll condense the book into 3 pages without illustrations.",
        clarification: "none",
        editTarget: "structural",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "It's too much talking. I think we should make it 3 pages without illustrations",
      chapters
    );
    // Without these the replan is quoted and planned as the book it replaces:
    // the model wrote three chapters and they were padded back to eight pages.
    expect(intent.replanSettings).toEqual({ fullIllustrations: false, targetPages: 3 });
  });

  it("prefers the router's numbers over the message when it reports them", () => {
    const intent = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.8,
        reasoning: "Half as long.",
        assistantMessage: "I’ll halve it.",
        clarification: "none",
        editTarget: "structural",
        editStyle: "rewrite",
        newTargetPages: 6,
        illustrationsEnabled: true,
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "make it half as long",
      chapters
    );
    expect(intent.replanSettings).toEqual({ fullIllustrations: true, targetPages: 6 });
  });

  it("reads no length from a request that names pages to edit", () => {
    const intent = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.8,
        reasoning: "Rewrite two pages.",
        assistantMessage: "I’ll rewrite those pages.",
        clarification: "none",
        editTarget: "structural",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "rewrite pages 3-5 around a new protagonist",
      chapters
    );
    // "pages 3" is a reference, not a length; reading it as one would shrink
    // the whole book to the page someone wanted changed.
    expect(intent.replanSettings).toBeUndefined();
  });

  it("classifies a length or image change as a replan without a router", () => {
    const intent = classifyWithDegradedHeuristics(
      "It's too much talking. I think we should make it 3 pages without illustrations",
      "complete",
      pages,
      undefined,
      chapters
    );
    // No verb in the structural regex matches this, but only a replan can change
    // how many pages a book has.
    expect(intent.kind).toBe("book_replan");
    expect(intent.replanSettings).toEqual({ fullIllustrations: false, targetPages: 3 });
  });
});

describe("printed page numbers a router copied", () => {
  // Cover on printed 1, Contents on 2, so every model page prints two ahead of
  // its index — the divergence a copied number silently ignores.
  const numbering = readerPageNumbering(
    bookPageMapForProject({
      pdfPageMap: {
        version: 1,
        totalPdfPages: 8,
        hasCoverPage: true,
        contentsStartPdfPage: 2,
        pages: [
          { index: 1, startPdfPage: 3, endPdfPage: 3 },
          { index: 2, startPdfPage: 4, endPdfPage: 5 },
          { index: 3, startPdfPage: 5, endPdfPage: 6 }
        ],
        contentRevision: 7
      },
      contentRevision: 7
    })
  );

  const proposeEdit = (decision: Partial<DecideActionPayload>) => ({
    action: "propose_edit" as const,
    confidence: 0.9,
    reasoning: "Page edit.",
    assistantMessage: "I’ll do that.",
    clarification: "none" as const,
    editStyle: "rewrite" as const,
    pageIndexes: [],
    chapterIndex: null,
    targetLanguage: null,
    ...decision
  });

  it("re-reads a copied page number as the model pages that printed page holds", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [5] }),
      "Rewrite page 5 to be funnier.",
      chapters,
      { pageNumbering: numbering }
    );

    // Printed page 5 carries the tail of model page 2 and the head of model 3.
    expect(intent.affectedPageIndexes).toEqual([2, 3]);
    expect(intent.scope).toBe("explicit_pages");
  });

  it("prefers the reader selection over a copied printed number", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [5] }),
      'On page 5, rewrite this passage: "the old phrase".',
      chapters,
      { pageNumbering: numbering, readerSelectionPageIndex: 2 }
    );

    // Printed page 5 covers model pages 2 and 3; the locator already picked 2.
    expect(intent.affectedPageIndexes).toEqual([2]);
    expect(intent.scope).toBe("explicit_pages");
  });

  it("fills a pageless page edit from the reader selection", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [] }),
      'Rewrite this passage: "the old phrase".',
      chapters,
      { readerSelectionPageIndex: 2 }
    );

    expect(intent.affectedPageIndexes).toEqual([2]);
    expect(intent.scope).toBe("explicit_pages");
  });

  it("prefers the reader selection over parsing the bubble without a router", () => {
    const mappedPages = [1, 2, 3].map((index) => ({
      id: `page-${index}`,
      index,
      title: `Page ${index}`,
      summary: "",
      previewText: "the old phrase"
    }));
    const withoutSelection = classifyWithDegradedHeuristics(
      'On page 5, rewrite this passage: "the old phrase".',
      "complete",
      mappedPages,
      undefined,
      chapters,
      { numbering }
    );
    expect(withoutSelection.affectedPageIndexes).toEqual([2, 3]);

    const withSelection = classifyWithDegradedHeuristics(
      'On page 5, rewrite this passage: "the old phrase".',
      "complete",
      mappedPages,
      undefined,
      chapters,
      { numbering, selectionPageIndex: 2 }
    );
    expect(withSelection.affectedPageIndexes).toEqual([2]);
    expect(withSelection.scope).toBe("explicit_pages");
  });

  it("keeps indexes the router actually translated", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [2] }),
      "Rewrite page 5 to be funnier.",
      chapters,
      { pageNumbering: numbering }
    );

    // 2 is not a number the message speaks, so the router read readerPages as
    // instructed and its answer stands.
    expect(intent.affectedPageIndexes).toEqual([2]);
  });

  it("leaves the router alone without a map, and when the message names no page", () => {
    const withoutMap = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [5] }),
      "Rewrite page 5 to be funnier.",
      chapters
    );
    expect(withoutMap.affectedPageIndexes).toEqual([5]);

    const nameless = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [5] }),
      "Make the ending funnier.",
      chapters,
      { pageNumbering: numbering }
    );
    expect(nameless.affectedPageIndexes).toEqual([5]);
  });

  it("re-reads a copied page number named only in Persian", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [5] }),
      "صفحه ۵ را بامزه‌تر بنویس",
      chapters,
      { pageNumbering: numbering }
    );

    expect(intent.affectedPageIndexes).toEqual([2, 3]);
    expect(intent.scope).toBe("explicit_pages");
  });

  it("leaves a printed number that holds no prose as the router wrote it", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [2] }),
      "Rewrite page 2.",
      chapters,
      { pageNumbering: numbering }
    );

    // Printed page 2 is the Contents: mapping it would move the edit onto a
    // neighbouring page nobody named, so the router's own answer stands.
    expect(intent.affectedPageIndexes).toEqual([2]);
  });

  it("re-reads the placement of an inserted picture", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_image", imageSubject: "a dragon", pageIndexes: [3] }),
      "Add a picture of a dragon on page 3.",
      chapters,
      { pageNumbering: numbering }
    );

    expect(intent.kind).toBe("add_image");
    expect(intent.imageEdit).toMatchObject({ placement: "page", pageIndex: 1 });
  });

  it("re-reads a Persian placement the router copied", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_image", imageSubject: "اژدها", pageIndexes: [3] }),
      "در صفحه ۳ یک عکس از اژدها اضافه کن",
      chapters,
      { pageNumbering: numbering }
    );

    expect(intent.kind).toBe("add_image");
    expect(intent.imageEdit).toMatchObject({ placement: "page", pageIndex: 1 });
  });

  it("re-reads both ends of a move", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "move_image", pageIndexes: [3], imageDestPageIndexes: [5] }),
      "Move the picture from page 3 to page 5.",
      chapters,
      { pageNumbering: numbering }
    );

    expect(intent.kind).toBe("move_image");
    // Neither channel matches the spoken set alone; together they are exactly it.
    expect(intent.imageLayout).toMatchObject({ pageIndex: 1, destPlacement: "page", destPageIndex: 2 });
  });

  it("re-reads the pages a clarify carries, because forcedDecision rewrites them", () => {
    const intent = intentFromDecideAction(
      {
        action: "clarify",
        confidence: 0.4,
        reasoning: "Ambiguous.",
        assistantMessage: "What should change on that page?",
        clarification: "scope",
        pageIndexes: [5],
        chapterIndex: null,
        targetLanguage: null
      },
      "Fix page 5.",
      chapters,
      { pageNumbering: numbering }
    );

    expect(intent.affectedPageIndexes).toEqual([2, 3]);
  });
});
