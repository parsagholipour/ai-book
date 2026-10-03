import { describe, expect, it } from "vitest";
import { classifyWithDegradedHeuristics } from "./bookEditHeuristics.js";
import { intentFromDecideAction } from "./bookEditDecision.js";
import { intentFromProposeEdit } from "./bookEditIntent.js";
import { structuralPageEditFromMessage, swapPagesFromMessage } from "./bookEditStructure.js";
import { readerPageNumbering } from "./bookPageNumbering.js";
import type { DecideActionPayload } from "./bookEditRouterPrompt.js";
import { structuralActionInstruction, structuralCardBlock } from "./mobile/structuralPageEdits.js";

/**
 * A printed sheet several short model pages share, read by both paths: the
 * model-free recogniser and the router's decision. Every spoken number is the
 * pages that begin on that sheet, an anchor takes the end of the sheet its side
 * names, and a swap or a numbers-only request is read whole by code.
 */
describe("both readings of an anchor on a crowded printed sheet", () => {
  // Printed page 10 is physical sheet 11, and three short model pages share it:
  // 7 ends there, 8 lies wholly within it, 9 starts there. That sheet is where
  // the two paths used to part company — the router's anchor took the last of
  // the three and the model-free recogniser took `primaryModelPageForPdfPage`'s
  // answer, model page 8 — so "add a page after page 10" opened the gap
  // mid-sheet or past it depending only on whether the router filled the
  // channel.
  const map = {
    version: 2 as const,
    totalPdfPages: 13,
    hasCoverPage: true,
    contentsStartPdfPage: 2,
    pages: [
      { index: 1, startPdfPage: 3, endPdfPage: 3 },
      { index: 2, startPdfPage: 4, endPdfPage: 4 },
      { index: 3, startPdfPage: 5, endPdfPage: 5 },
      { index: 4, startPdfPage: 6, endPdfPage: 6 },
      { index: 5, startPdfPage: 7, endPdfPage: 7 },
      { index: 6, startPdfPage: 8, endPdfPage: 9 },
      { index: 7, startPdfPage: 10, endPdfPage: 11 },
      { index: 8, startPdfPage: 11, endPdfPage: 11 },
      { index: 9, startPdfPage: 11, endPdfPage: 12 },
      { index: 10, startPdfPage: 13, endPdfPage: 13 }
    ]
  };
  const numbering = readerPageNumbering(map);
  const context = { pdfPageMap: map };
  const crowdedPages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((index) => ({
    id: `page-${index}`,
    index,
    title: `The ${index} Winds`,
    summary: "",
    previewText: ""
  }));

  const proposeEdit = (decision: Partial<DecideActionPayload>) =>
    ({
      action: "propose_edit" as const,
      confidence: 0.9,
      reasoning: "Structural page edit.",
      assistantMessage: "I’ll do that.",
      clarification: "none" as const,
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null,
      ...decision
    }) as DecideActionPayload;

  it("lands an insert after the last model page of the sheet on both paths", () => {
    // The model-free recogniser, which is what a router outage leaves.
    expect(structuralPageEditFromMessage("Add a page after page 10.", crowdedPages, context)).toEqual({
      edit: { action: "insert", anchorPageIndex: 9, pageIndexes: [], pageCount: 1 },
      anchored: true
    });
    // The same message through the whole degraded classifier.
    expect(
      classifyWithDegradedHeuristics("Add a page after page 10.", "complete", crowdedPages, undefined, [], {
        numbering
      }).structuralEdit
    ).toEqual({ action: "insert", anchorPageIndex: 9, pageIndexes: [], pageCount: 1 });
    // And the router path, whose anchor channel is the printed number the
    // reader typed and gets re-read through the same map.
    expect(
      intentFromProposeEdit(
        proposeEdit({ editTarget: "insert_pages", structuralAnchorPageIndex: 10, structuralPageCount: 1 }),
        "Add a page after page 10.",
        [],
        { pageNumbering: numbering }
      ).structuralEdit
    ).toEqual({ action: "insert", anchorPageIndex: 9, pageIndexes: [], pageCount: 1 });
    // The borrowed anchor: the router named the edit and left the place to the
    // message, so `structuralIntentFromDecision` takes the recogniser's — which
    // is only safe while the two agree.
    expect(
      intentFromProposeEdit(
        proposeEdit({ editTarget: "insert_pages", structuralPageCount: 1 }),
        "Add a page after page 10.",
        [],
        { pageNumbering: numbering }
      ).structuralEdit?.anchorPageIndex
    ).toBe(9);
  });

  it("puts a 'before' anchor ahead of the pages that begin on the sheet, on both paths", () => {
    // Page 7 began on printed 9 and runs onto 10; 8 and 9 begin on 10. Ahead of
    // every page touching the sheet was ahead of page 9's text, a sheet early,
    // and the card then had to say "before page 9".
    expect(structuralPageEditFromMessage("Add a page before page 10.", crowdedPages, context)?.edit).toMatchObject({
      action: "insert",
      anchorPageIndex: 7,
      anchorSide: "before"
    });
    expect(
      intentFromProposeEdit(
        proposeEdit({
          editTarget: "insert_pages",
          structuralAnchorPageIndex: 10,
          structuralAnchorPosition: "before",
          structuralPageCount: 1
        }),
        "Add a page before page 10.",
        [],
        { pageNumbering: numbering }
      ).structuralEdit
    ).toEqual({ action: "insert", anchorPageIndex: 7, anchorSide: "before", pageIndexes: [], pageCount: 1 });
  });

  it("gives a move the same destination on both paths, and keeps its sources apart from it", () => {
    // Printed 3 is model page 2 — the pages to move — and printed 10 is the
    // sheet the reader named as the place, which is three model pages wide.
    const expected = { action: "move", anchorPageIndex: 9, pageIndexes: [2], pageCount: 0 };
    expect(structuralPageEditFromMessage("Move page 3 to after page 10.", crowdedPages, context)?.edit).toEqual(
      expected
    );
    expect(
      intentFromProposeEdit(
        proposeEdit({ editTarget: "move_pages", pageIndexes: [3], structuralAnchorPageIndex: 10 }),
        "Move page 3 to after page 10.",
        [],
        { pageNumbering: numbering }
      ).structuralEdit
    ).toEqual(expected);
  });

  it("reads a deleted or moved page as the pages that begin on that sheet, on both paths", () => {
    // Printed 9 is where model page 7 begins (it runs on to printed 10); printed
    // 10 is where pages 8 and 9 begin. Every model page begins on exactly one
    // sheet, so the spoken numbers split the book with nothing counted twice —
    // reading every page that *touches* a sheet took page 7 twice over and a
    // delete of two numbers out of three pages' worth of other sheets.
    expect(structuralPageEditFromMessage("Delete pages 9 and 10", crowdedPages, context)?.edit).toEqual({
      action: "delete",
      anchorPageIndex: null,
      pageIndexes: [7, 8, 9],
      pageCount: 0
    });
    // A router that translated the same numbers its own way is overruled: every
    // page it named lies on a sheet the reader spoke, so it was only translating.
    expect(
      intentFromProposeEdit(
        proposeEdit({ editTarget: "delete_pages", pageIndexes: [7, 8] }),
        "Delete pages 9 and 10",
        [],
        { pageNumbering: numbering }
      ).structuralEdit?.pageIndexes
    ).toEqual([7, 8, 9]);
    // Asked as a question, the router still decided a delete; only the pages are read here.
    expect(
      intentFromProposeEdit(
        proposeEdit({ editTarget: "delete_pages", pageIndexes: [7, 8] }),
        "Delete pages 9 and 10?",
        [],
        { pageNumbering: numbering }
      ).structuralEdit?.pageIndexes
    ).toEqual([7, 8, 9]);
    // A page the router found some other way is not the code's to replace.
    expect(
      intentFromProposeEdit(
        proposeEdit({ editTarget: "delete_pages", pageIndexes: [2, 7] }),
        "Delete page 9 and the page about the market",
        [],
        { pageNumbering: numbering }
      ).structuralEdit?.pageIndexes
    ).toEqual([2, 7]);
  });

  it("reads a range written with a word, either way round", () => {
    // Printed 2-4 are where model pages 1-3 begin. "to" used to end the list,
    // so "pages 2 to 4" named page 2 alone while the classifier priced the
    // three-page delete the reader asked for.
    for (const message of ["Delete pages 2 to 4", "delete pages 2 through 4", "delete pages 4 to 2", "delete pages 4-2"]) {
      expect(structuralPageEditFromMessage(message, crowdedPages, context)?.edit.pageIndexes, message).toEqual([1, 2, 3]);
    }
  });

  it("takes a numbers-only request's pages from code, even where the router guessed elsewhere", () => {
    // "delete page 0" names no page; the router offered the first one. Empty,
    // the selection is refused at the proposal with "which page you mean".
    expect(
      intentFromProposeEdit(proposeEdit({ editTarget: "delete_pages", pageIndexes: [1] }), "delete page 0", [], {
        pageNumbering: numbering
      }).structuralEdit?.pageIndexes
    ).toEqual([]);
    // Printed 3 is model page 2; a router that named page 7 for it is overruled.
    expect(
      intentFromProposeEdit(proposeEdit({ editTarget: "delete_pages", pageIndexes: [7] }), "delete page 3", [], {
        pageNumbering: numbering
      }).structuralEdit?.pageIndexes
    ).toEqual([2]);
    // A page named by what it holds is still the router's to find.
    expect(
      intentFromProposeEdit(
        proposeEdit({ editTarget: "delete_pages", pageIndexes: [2, 7] }),
        "delete page 3 and the page about the market",
        [],
        { pageNumbering: numbering }
      ).structuralEdit?.pageIndexes
    ).toEqual([2, 7]);
  });

  it("reads a swap of two neighbouring pages as the one move that performs it, on both paths", () => {
    // Printed 9 is where page 7 begins and printed 10 where 8 and 9 do, so the
    // swap puts 8 and 9 ahead of 7. "swap" is in no move grammar, and read as
    // prose the router's restatement of it was quoted as a whole-book rebuild.
    const swapped = { action: "move", anchorPageIndex: 6, anchorSide: "before", pageIndexes: [8, 9], pageCount: 0 };
    for (const message of ["swap pages 9 and 10", "Switch page 10 with page 9", "swap the order of pages 9 and 10"]) {
      expect(structuralPageEditFromMessage(message, crowdedPages, context)?.edit, message).toEqual(swapped);
    }
    // The router can write the same swap the other way round; code reads it
    // whole, so its pages never meet the router's anchor and move a page after
    // itself.
    expect(
      intentFromProposeEdit(
        proposeEdit({ editTarget: "move_pages", pageIndexes: [7], structuralAnchorPageIndex: 9 }),
        "swap pages 9 and 10",
        [],
        { pageNumbering: numbering }
      ).structuralEdit
    ).toEqual(swapped);
  });

  it("does not read a swap no single move performs as a move", () => {
    // Pages 1 and 4 lie between printed 2 and 5: two moves, answered by the proposal.
    expect(swapPagesFromMessage("swap pages 2 and 5", crowdedPages, context)).toEqual({
      spoken: [2, 5],
      edit: null,
      samePage: false
    });
    expect(structuralPageEditFromMessage("swap pages 2 and 5", crowdedPages, context)).toBeNull();
    // Printed 11 begins no page; page 9 runs onto it from printed 10.
    expect(swapPagesFromMessage("swap pages 10 and 11", crowdedPages, context)?.samePage).toBe(true);
    expect(swapPagesFromMessage("swap the picture on page 2 with page 5", crowdedPages, context)).toBeNull();
  });

  it("still refuses to write a page for a reorder that has nowhere to go", () => {
    // Printed 12 is model page 10, the book's last, so "at the end" is where it
    // already is: every source is the destination, the move declines, and the
    // insert reading must not pick it up — a numbered page is never a page to
    // write. That guard is what keeps a free reorder off a charged card, and it
    // survives the destination becoming a set.
    expect(structuralPageEditFromMessage("Put page 12 at the end", crowdedPages, context)).toBeNull();
    // The sheet's own pages, though, are a real thing to move: printed 10 is
    // where model pages 8 and 9 begin, and neither is the destination. Page 7
    // only ends there — it began on printed 9 and belongs to that page, so a
    // reorder of "page 10" does not carry printed 9's text with it.
    expect(structuralPageEditFromMessage("Put page 10 at the end", crowdedPages, context)?.edit).toEqual({
      action: "move",
      anchorPageIndex: 10,
      pageIndexes: [8, 9],
      pageCount: 0
    });
  });

  it("names a place from the side the reader named it, on the card and on the wire", () => {
    // "Before page 10" lands after page 7, which ends on printed 10 where 8
    // begins: the same sheet, so "after page 10" was true and read as the
    // opposite of the request.
    const before = structuralPageEditFromMessage("Add a page before page 10.", crowdedPages, context)!.edit;
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_pages", structuralPageCount: 1 }),
      "Add a page before page 10.",
      [],
      { pageNumbering: numbering }
    );
    expect(intent.structuralEdit).toEqual(before);
    expect(structuralActionInstruction(intent, numbering)).toBe("Add 1 new page before page 10");
    const card = { action: "insert" as const, pageCount: 1, totalPages: 11, insertAfterIndex: 7 };
    expect(structuralCardBlock(intent, card, numbering)).toMatchObject({
      placement: "before",
      beforeReaderPage: 10,
      // Builds that know no "before" keep the number they were always given.
      afterReaderPage: 10
    });
    // A swap of printed 9 and 10 puts 8 and 9 before 7, which begins on 9.
    const swap = structuralPageEditFromMessage("swap pages 9 and 10", crowdedPages, context)!.edit;
    expect(structuralActionInstruction({ ...intent, structuralEdit: swap }, numbering)).toBe(
      "Move pages 10, 11 before page 9"
    );
    // Named from "after", the same kind of gap keeps the wording every card has had.
    const after = structuralPageEditFromMessage("Add a page after page 9.", crowdedPages, context)!.edit;
    expect(after.anchorSide).toBeUndefined();
    expect(structuralActionInstruction({ ...intent, structuralEdit: after }, numbering)).toBe(
      "Add 1 new page after page 10"
    );
  });

  it("settles a numbered delete or move the router asked about, and nothing else", () => {
    // Printed 10 is shared by three pages; the router asked which one for the
    // spelled-out number and offered a card for the digit. Code's answer is the
    // pages that begin on the sheet, either way.
    const asked = (message: string, action: "clarify" | "answer" = "clarify") =>
      intentFromDecideAction(
        {
          action,
          confidence: 0.4,
          reasoning: "Printed page 10 holds several pages.",
          assistantMessage: "Which page should I remove?",
          editInstruction: ""
        } as unknown as DecideActionPayload,
        message,
        [],
        { pageNumbering: numbering }
      );
    for (const message of ["remove page ten", "Remove page 10", "can you delete page ten?"]) {
      expect(asked(message).structuralEdit, message).toEqual({
        action: "delete",
        anchorPageIndex: null,
        pageIndexes: [8, 9],
        pageCount: 0
      });
      expect(asked(message).kind).toBe("restructure_pages");
    }
    expect(asked("move page ten to the end", "answer").structuralEdit?.pageIndexes).toEqual([8, 9]);
    // A number with no page on it, a move with no place, a second request and a
    // question about the book stay the router's.
    expect(asked("delete page 0", "answer").kind).toBe("answer");
    expect(asked("move page ten").kind).toBe("clarify");
    expect(asked("remove page ten and rewrite page eleven").kind).toBe("clarify");
    expect(asked("should I delete page ten?").kind).toBe("clarify");
  });
});
