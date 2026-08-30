import { describe, expect, it } from "vitest";
import { intentFromDecideAction, intentFromProposeEdit } from "./bookEditIntent.js";
import { classifyWithDegradedHeuristics } from "./bookEditHeuristics.js";
import { bookPageMapForProject, readerPageNumbering } from "./bookPageNumbering.js";
import { type DecideActionPayload } from "./bookEditRouterPrompt.js";
import { exactReplacementForIntent } from "./mobile/bookEditScope.js";

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

  it("retains only router replacement terms proven by the durable instruction", () => {
    const decide = (editInstruction: string, replacementFrom: string, replacementTo: string) =>
      intentFromProposeEdit(
        {
          action: "propose_edit",
          confidence: 0.9,
          reasoning: "Exact replacement.",
          assistantMessage: "I’ll apply the replacement.",
          clarification: "none",
          editTarget: "whole_book",
          editStyle: "exact_replace",
          editInstruction,
          pageIndexes: [],
          chapterIndex: null,
          targetLanguage: null,
          replacementFrom,
          replacementTo
        },
        editInstruction,
        chapters
      );

    const proven = decide('Replace "Rabbit" with "Silver Fox" everywhere.', "Rabbit", "Silver Fox");
    expect(proven.exactReplacement).toEqual({ from: "Rabbit", to: "Silver Fox" });
    expect(exactReplacementForIntent(proven, proven.editInstruction!)).toEqual({
      from: "Rabbit",
      to: "Silver Fox"
    });

    const disagreement = decide('Replace "Rabbit" with "Hare" everywhere.', "Rabbit", "Fox");
    expect(disagreement.exactReplacement).toBeNull();
    expect(exactReplacementForIntent(disagreement, disagreement.editInstruction!)).toBeNull();

    const ambiguous = decide("Rename the hero Rabbit to Fox everywhere.", "hero Rabbit", "Fox");
    expect(ambiguous.exactReplacement).toBeNull();
    expect(exactReplacementForIntent(ambiguous, ambiguous.editInstruction!)).toBeNull();
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
  // Cover is unnumbered, Contents is printed 1, so model pages print one ahead
  // of a naive physical count — the divergence a copied number silently ignores.
  const numbering = readerPageNumbering(
    bookPageMapForProject({
      pdfPageMap: {
        version: 2,
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
      proposeEdit({ editTarget: "pages", pageIndexes: [4] }),
      "Rewrite page 4 to be funnier.",
      chapters,
      { pageNumbering: numbering }
    );

    // Printed page 4 is physical 5, which carries the tail of model page 2 and
    // the head of model 3.
    expect(intent.affectedPageIndexes).toEqual([2, 3]);
    expect(intent.scope).toBe("explicit_pages");
  });

  it("re-reads a whole list of copied page numbers", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [2, 4, 5] }),
      "Rewrite pages 2, 4 and 5.",
      chapters,
      { pageNumbering: numbering }
    );

    // Printed 2 is model 1, printed 4 is the boundary of models 2 and 3, and
    // printed 5 is model 3. The guard fires only because the message parser
    // reads the whole list: with only "2" spoken, the set comparison fails and
    // all three printed numbers are silently used as model indexes instead.
    expect(intent.affectedPageIndexes).toEqual([1, 2, 3]);
    expect(intent.scope).toBe("explicit_pages");
  });

  it("translates each per-page instruction onto the model pages that printed page holds", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({
        editTarget: "pages",
        pageIndexes: [2, 4],
        perPageInstructions: [
          { pageIndex: 2, instruction: "Make it funnier." },
          { pageIndex: 4, instruction: "Make it shorter." }
        ]
      }),
      "Make page 2 funnier and page 4 shorter.",
      chapters,
      { pageNumbering: numbering }
    );

    // Printed 2 is model 1; printed 4 is the boundary of models 2 and 3, so the
    // instruction for it covers both. Each entry rides its own channel for
    // exactly this reason — one shared list would lose which page it belonged to.
    expect(intent.affectedPageIndexes).toEqual([1, 2, 3]);
    expect(intent.perPageInstructions).toEqual([
      { pageIndex: 1, instruction: "Make it funnier." },
      { pageIndex: 2, instruction: "Make it shorter." },
      { pageIndex: 3, instruction: "Make it shorter." }
    ]);
  });

  it("prices a page the router wrote an instruction for but left out of pageIndexes", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({
        editTarget: "pages",
        pageIndexes: [],
        perPageInstructions: [{ pageIndex: 3, instruction: "Trim the opening." }]
      }),
      "Trim the opening of that page.",
      chapters
    );

    // An instruction is a request to edit that page, so it has to reach the
    // set the card counts and the charge multiplies.
    expect(intent.affectedPageIndexes).toEqual([3]);
    expect(intent.scope).toBe("explicit_pages");
  });

  it("stands aside when the router named only some of the pages the message speaks", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [2] }),
      "Rewrite pages 2 and 4.",
      chapters,
      { pageNumbering: numbering }
    );

    // Deliberately a set *equality* rather than a containment test. A router
    // that translated correctly can also answer a subset of the numbers the
    // message speaks — an index that happens to equal one of them — and
    // translating that a second time moves the edit to a page nobody named.
    // Declining keeps the router's own answer, which is the safe half.
    expect(intent.affectedPageIndexes).toEqual([2]);
  });

  it("prefers the reader selection over a copied printed number", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [4] }),
      'On page 4, rewrite this passage: "the old phrase".',
      chapters,
      { pageNumbering: numbering, readerSelectionPageIndex: 2 }
    );

    // Printed page 4 covers model pages 2 and 3; the locator already picked 2.
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
      'On page 4, rewrite this passage: "the old phrase".',
      "complete",
      mappedPages,
      undefined,
      chapters,
      { numbering }
    );
    expect(withoutSelection.affectedPageIndexes).toEqual([2, 3]);

    const withSelection = classifyWithDegradedHeuristics(
      'On page 4, rewrite this passage: "the old phrase".',
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
      proposeEdit({ editTarget: "pages", pageIndexes: [4] }),
      "صفحه ۴ را بامزه‌تر بنویس",
      chapters,
      { pageNumbering: numbering }
    );

    expect(intent.affectedPageIndexes).toEqual([2, 3]);
    expect(intent.scope).toBe("explicit_pages");
  });

  it("leaves a printed number that holds no prose as the router wrote it", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "pages", pageIndexes: [1] }),
      "Rewrite page 1.",
      chapters,
      { pageNumbering: numbering }
    );

    // Printed page 1 is the Contents: mapping it would move the edit onto a
    // neighbouring page nobody named, so the router's own answer stands.
    expect(intent.affectedPageIndexes).toEqual([1]);
  });

  it("re-reads the placement of an inserted picture", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_image", imageSubject: "a dragon", pageIndexes: [2] }),
      "Add a picture of a dragon on page 2.",
      chapters,
      { pageNumbering: numbering }
    );

    expect(intent.kind).toBe("add_image");
    expect(intent.imageEdit).toMatchObject({ placement: "page", pageIndex: 1 });
  });

  it("re-reads a Persian placement the router copied", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_image", imageSubject: "اژدها", pageIndexes: [2] }),
      "در صفحه ۲ یک عکس از اژدها اضافه کن",
      chapters,
      { pageNumbering: numbering }
    );

    expect(intent.kind).toBe("add_image");
    expect(intent.imageEdit).toMatchObject({ placement: "page", pageIndex: 1 });
  });

  it("re-reads both ends of a move", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "move_image", pageIndexes: [2], imageDestPageIndexes: [3] }),
      "Move the picture from page 2 to page 3.",
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
        pageIndexes: [4],
        chapterIndex: null,
        targetLanguage: null
      },
      "Fix page 4.",
      chapters,
      { pageNumbering: numbering }
    );

    expect(intent.affectedPageIndexes).toEqual([2, 3]);
  });
});
