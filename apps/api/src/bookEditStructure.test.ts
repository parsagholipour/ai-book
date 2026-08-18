import { resolveStructuralPageEdit } from "@book-maker/core";
import { describe, expect, it } from "vitest";
import { classifyWithDegradedHeuristics } from "./bookEditHeuristics.js";
import { intentFromProposeEdit } from "./bookEditIntent.js";
import { structuralPageEditFromMessage } from "./bookEditStructure.js";
import { bookPageMapForProject, readerPageNumbering } from "./bookPageNumbering.js";
import type { DecideActionPayload } from "./bookEditRouterPrompt.js";

const pages = [1, 2, 3, 4, 5, 6].map((index) => ({
  id: `page-${index}`,
  index,
  title: `The ${index} Winds`,
  summary: "",
  previewText: ""
}));

describe("reading a structural page request without a model", () => {
  it("reads an insertion with its count and its anchor", () => {
    expect(structuralPageEditFromMessage("Add 3 pages after page 4", pages)).toEqual({
      edit: { action: "insert", anchorPageIndex: 4, pageIndexes: [], pageCount: 3 },
      anchored: true
    });
    expect(structuralPageEditFromMessage("insert two new pages after page 2", pages)?.edit).toMatchObject({
      anchorPageIndex: 2,
      pageCount: 2
    });
  });

  it("reads 'before page N' as 'after page N-1', and before page 1 as the front", () => {
    expect(structuralPageEditFromMessage("add a page before page 5", pages)?.edit).toMatchObject({
      anchorPageIndex: 4,
      pageCount: 1
    });
    // A new opening page is a real request, not an out-of-range anchor.
    expect(structuralPageEditFromMessage("add a page before page 1", pages)?.edit).toMatchObject({
      anchorPageIndex: 0
    });
  });

  it("leaves an unanchored insert with no place named rather than guessing one", () => {
    // Null, not zero: zero is the front of the book, and an insert with nothing
    // named appends — a difference the card states before anything is charged.
    expect(structuralPageEditFromMessage("add two more pages", pages)).toEqual({
      edit: { action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 2 },
      anchored: false
    });
    expect(structuralPageEditFromMessage("add two pages at the end of the book", pages)?.edit).toMatchObject({
      anchorPageIndex: 6
    });
  });

  it("leaves 'at the end' unanchored when it has no book to measure", () => {
    // The decision path calls in with no pages at all, and the empty reduce
    // used to make "the end" index 0 — the *front* — with anchored true, so the
    // caller took it. Null is the same place the reader named: an insert with
    // no anchor appends.
    expect(structuralPageEditFromMessage("add two pages at the end of the book", [])).toEqual({
      edit: { action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 2 },
      anchored: false
    });
    // A named anchor never needed the book's length, and still resolves.
    expect(structuralPageEditFromMessage("add a page after page 2", [])?.edit).toMatchObject({
      anchorPageIndex: 2
    });
  });

  it("reads a delete and a move", () => {
    expect(structuralPageEditFromMessage("delete page 3", pages)?.edit).toMatchObject({
      action: "delete",
      pageIndexes: [3]
    });
    expect(structuralPageEditFromMessage("remove pages 2 and 5", pages)?.edit).toMatchObject({
      action: "delete",
      pageIndexes: [2, 5]
    });
    expect(structuralPageEditFromMessage("move page 5 to after page 1", pages)?.edit).toMatchObject({
      action: "move",
      pageIndexes: [5],
      anchorPageIndex: 1
    });
  });

  it("reads 'put page N after page M' as the move it is, not a one-page insert", () => {
    // "Put" is an insert verb and a move verb, and the insert count is
    // optional, so this matches both patterns. Read as an insert it opened one
    // blank page after page 1 and left page 3 where it was.
    expect(structuralPageEditFromMessage("put page 3 after page 1", pages)?.edit).toMatchObject({
      action: "move",
      pageIndexes: [3],
      anchorPageIndex: 1
    });
    expect(structuralPageEditFromMessage("put page 5 before page 2", pages)?.edit).toMatchObject({
      action: "move",
      pageIndexes: [5],
      anchorPageIndex: 1
    });
    expect(structuralPageEditFromMessage("put pages 4 and 5 after page 1", pages)?.edit).toMatchObject({
      action: "move",
      pageIndexes: [4, 5],
      anchorPageIndex: 1
    });
  });

  it("reads 'at the end' as the move destination it is, not as a new page to write", () => {
    // "Put" is both verbs, and the move reading used to refuse an end anchor
    // outright — so this fell through to the insert reading and became a card
    // offering to *write* a page at pageRegenerationPerPage, for a reorder
    // that bills nothing. "The end" is the last page's own index, which
    // `resolveStructuralPageEdit` reads like any other anchor.
    expect(structuralPageEditFromMessage("put page 3 at the end", pages)).toEqual({
      edit: { action: "move", anchorPageIndex: 6, pageIndexes: [3], pageCount: 0 },
      anchored: true
    });
    expect(structuralPageEditFromMessage("move page 3 to the end", pages)?.edit).toMatchObject({
      action: "move",
      anchorPageIndex: 6,
      pageIndexes: [3]
    });
    expect(structuralPageEditFromMessage("put pages 4 and 5 at the end of the book", pages)?.edit).toMatchObject({
      action: "move",
      anchorPageIndex: 6,
      pageIndexes: [4, 5]
    });
    // The ordinal form names a page to move as surely as the number does.
    expect(structuralPageEditFromMessage("put the third page at the end", pages)?.edit).toMatchObject({
      action: "move",
      anchorPageIndex: 6,
      pageIndexes: [3]
    });
  });

  it("never reads a page the message numbered as a page to write", () => {
    // What the move reading declines falls through to the insert reading, and
    // the insert is the reading that costs credits: every one of these was a
    // brand-new page at pageRegenerationPerPage. A page that does not exist
    // yet cannot be numbered, so the numbered object is the whole of the rule
    // — and what it declines to is the free clarifying question.
    for (const message of [
      // A destination this file's grammar does not know.
      "put page 3 last",
      "put page three last",
      // Not the page but what it holds, which is a free edit of its own.
      "put page 3’s picture at the end",
      // Already the last page: nothing to reorder, and still not a page to write.
      "put page 6 at the end"
    ]) {
      expect(structuralPageEditFromMessage(message, pages), message).toBeNull();
    }
  });

  it("still reads 'put' as an insert when the message names no page to move", () => {
    // The move reading is the narrower one, so trying it first costs these
    // nothing: they name a destination and no source.
    expect(structuralPageEditFromMessage("put a page after page 3", pages)?.edit).toMatchObject({
      action: "insert",
      anchorPageIndex: 3,
      pageCount: 1
    });
    expect(structuralPageEditFromMessage("put in two new pages after page 2", pages)?.edit).toMatchObject({
      action: "insert",
      anchorPageIndex: 2,
      pageCount: 2
    });
    // A count is not a page number: "two pages" names how many, not which.
    expect(structuralPageEditFromMessage("put two pages at the end", pages)?.edit).toMatchObject({
      action: "insert",
      anchorPageIndex: 6,
      pageCount: 2
    });
  });

  it("stands aside for requests that merely name a page", () => {
    // "Add a picture to page 3" names a page; it does not ask for one.
    expect(structuralPageEditFromMessage("add a picture of a dragon to page 3", pages)).toBeNull();
    expect(structuralPageEditFromMessage("make page 3 funnier", pages)).toBeNull();
    expect(structuralPageEditFromMessage("how many pages does this book have?", pages)).toBeNull();
  });

  it("stands aside when the verb acts on something the page holds", () => {
    // The whole battery of live false positives: the verb reached a page word
    // through twenty arbitrary characters, so every one of these was answered
    // with "I'll remove that page and renumber the rest of the book" — and the
    // picture edits it spoke over are free and touch no page at all.
    for (const message of [
      "remove the picture on page 3",
      "remove the image on page 3",
      "delete the photo from page 2",
      "remove the illustration from page 3",
      "delete the drawing on page 6",
      "remove the title on page 4",
      "delete the last line on page 3",
      "move the picture on page 3 to after page 5",
      "put the photo on page 2 after page 5"
    ]) {
      expect(structuralPageEditFromMessage(message, pages), message).toBeNull();
    }
  });

  it("stands aside when the page word is a locator rather than the object", () => {
    // Right where the object goes, and still not the object: the word after it
    // is the tell. The first two were priced readings — a new page each.
    expect(structuralPageEditFromMessage("add page numbers to the book", pages)).toBeNull();
    expect(structuralPageEditFromMessage("write a page turner", pages)).toBeNull();
    expect(structuralPageEditFromMessage("remove the page numbers", pages)).toBeNull();
    expect(structuralPageEditFromMessage("delete page 3’s picture", pages)).toBeNull();
    // A shorter page, not one page fewer.
    expect(structuralPageEditFromMessage("cut page 3 down to half", pages)).toBeNull();
    // A refusal is not a request.
    expect(structuralPageEditFromMessage("please don’t delete page 3", pages)).toBeNull();
    // No page named as the object, and the page it did name is not the one it
    // asked about — this used to delete page 4.
    expect(structuralPageEditFromMessage("delete the page after page 4", pages)).toBeNull();
  });

  it("takes its pages from the verb's own clause, not from the whole message", () => {
    // The reason a delete names is not a second page to delete.
    expect(structuralPageEditFromMessage("delete page 3, it repeats page 7", pages)?.edit).toMatchObject({
      action: "delete",
      pageIndexes: [3]
    });
    expect(structuralPageEditFromMessage("delete page 3 and the picture on page 5", pages)?.edit).toMatchObject({
      action: "delete",
      pageIndexes: [3]
    });
    // A list is still one request, however the reader repeats the page word.
    expect(structuralPageEditFromMessage("delete page 2 and page 4", pages)?.edit).toMatchObject({
      pageIndexes: [2, 4]
    });
    expect(structuralPageEditFromMessage("remove pages 2, 5 and 6", pages)?.edit).toMatchObject({
      pageIndexes: [2, 5, 6]
    });
    expect(structuralPageEditFromMessage("take out pages 2-4", pages)?.edit).toMatchObject({
      pageIndexes: [2, 3, 4]
    });
    // The ordinal form names a page as surely as the number does.
    expect(structuralPageEditFromMessage("remove the first page", pages)?.edit).toMatchObject({
      action: "delete",
      pageIndexes: [1]
    });
  });
});

describe("a structural request with no router model at all", () => {
  it("stays a page edit instead of becoming a whole-book replan", () => {
    // The incident this exists to stop: "add a page" matched the structural
    // battery and became book_replan, which forks a NEW project and
    // regenerates the whole book, priced as a whole book.
    const intent = classifyWithDegradedHeuristics("Add 3 pages after page 4", "complete", pages);

    expect(intent.kind).toBe("restructure_pages");
    expect(intent.structuralEdit).toEqual({
      action: "insert",
      anchorPageIndex: 4,
      pageIndexes: [],
      pageCount: 3
    });
    // Empty on purpose: affectedPagesForIntent filters against pages that
    // exist, and these do not yet.
    expect(intent.affectedPageIndexes).toEqual([]);
  });

  it("routes a delete and a move the same way", () => {
    expect(classifyWithDegradedHeuristics("delete page 3", "complete", pages).kind).toBe("restructure_pages");
    expect(classifyWithDegradedHeuristics("move page 5 to after page 1", "complete", pages).kind).toBe(
      "restructure_pages"
    );
  });

  it("moves the page a 'put' names instead of inserting beside it", () => {
    // The live router usually reads this correctly; this path is the one that
    // runs when it cannot, which is the whole reason the recogniser exists.
    expect(classifyWithDegradedHeuristics("put page 3 after page 1", "complete", pages).structuralEdit).toEqual({
      action: "move",
      anchorPageIndex: 1,
      pageIndexes: [3],
      pageCount: 0
    });
  });

  it("moves a page sent to the end instead of charging for a new one", () => {
    // The outage path is where the money is: read as an insert this was a
    // proposal card to write one new page at pageRegenerationPerPage, for a
    // request the resolver performs for free.
    const intent = classifyWithDegradedHeuristics("put page 3 at the end", "complete", pages);

    expect(intent.kind).toBe("restructure_pages");
    expect(intent.structuralEdit).toEqual({
      action: "move",
      anchorPageIndex: 6,
      pageIndexes: [3],
      pageCount: 0
    });
    const resolved = resolveStructuralPageEdit(intent.structuralEdit!, pages);
    expect(resolved.ok && resolved.plan.pagesBilled).toBe(0);
    expect(resolved.ok && resolved.plan.order.at(-1)?.pageId).toBe("page-3");
  });

  it("asks rather than charging when the destination is one it cannot read", () => {
    // "Last" is not a destination this file's grammar knows, and what it used
    // to fall through to was the charged reading.
    expect(classifyWithDegradedHeuristics("put page 3 last", "complete", pages).kind).not.toBe("restructure_pages");
  });

  it("sends a page-scoped picture request to neither a page delete nor a replan", () => {
    // Both halves of the same line. The recogniser no longer reads it as a
    // whole-page delete — and what it falls through to must not be the replan
    // battery, which reads "remove … picture" as a decision about the book and
    // would quote a whole rebuild with illustrations switched off for good.
    for (const message of ["remove the picture on page 3", "remove the illustration from page 3"]) {
      const intent = classifyWithDegradedHeuristics(message, "complete", pages);
      expect(intent.kind, message).not.toBe("restructure_pages");
      expect(intent.kind, message).not.toBe("book_replan");
      expect(intent.replanSettings, message).toBeUndefined();
    }
  });

  it("still replans when the picture decision is about the book", () => {
    // Naming no page is what makes it a book-wide decision.
    expect(classifyWithDegradedHeuristics("remove all the pictures", "complete", pages).kind).toBe("book_replan");
    expect(classifyWithDegradedHeuristics("turn off the illustrations", "complete", pages).kind).toBe("book_replan");
  });

  it("still sends a real length change to the replan", () => {
    // Dropping "page" from the structural battery must not take "chapter" and
    // "section" with it, nor the length reading structural is actually for.
    expect(classifyWithDegradedHeuristics("make it 3 pages long", "complete", pages).kind).toBe("book_replan");
    expect(classifyWithDegradedHeuristics("remove a chapter from the book", "complete", pages).kind).toBe(
      "book_replan"
    );
    expect(classifyWithDegradedHeuristics("add a section about the ending", "complete", pages).kind).toBe(
      "book_replan"
    );
    // Adding chapters was, and stays, a continuation rather than a replan.
    expect(classifyWithDegradedHeuristics("add a chapter about the ending", "complete", pages).kind).toBe(
      "continue_book"
    );
  });
});

describe("a structural request through the router model", () => {
  // Cover unnumbered, Contents printed 1, so printed numbers run one ahead of
  // a naive physical count — the divergence a copied anchor ignores.
  const numbering = readerPageNumbering(
    bookPageMapForProject({
      pdfPageMap: {
        version: 2,
        totalPdfPages: 8,
        hasCoverPage: true,
        contentsStartPdfPage: 2,
        pages: [
          { index: 1, startPdfPage: 3, endPdfPage: 3 },
          { index: 2, startPdfPage: 4, endPdfPage: 4 },
          { index: 3, startPdfPage: 5, endPdfPage: 6 }
        ],
        contentRevision: 7
      },
      contentRevision: 7
    })
  );

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

  it("re-reads an anchor the router copied out of the message", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_pages", structuralAnchorPageIndex: 3, structuralPageCount: 2 }),
      "Add two pages after page 3.",
      [],
      { pageNumbering: numbering }
    );

    // Printed 3 is physical 4, which is model page 2. Left as "3" the gap would
    // open after a different page than the reader pointed at.
    expect(intent.kind).toBe("restructure_pages");
    expect(intent.structuralEdit).toEqual({
      action: "insert",
      anchorPageIndex: 2,
      pageIndexes: [],
      pageCount: 2
    });
  });

  it("keeps an anchor the router translated itself", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_pages", structuralAnchorPageIndex: 2, structuralPageCount: 1 }),
      "Add a page after page 3.",
      [],
      { pageNumbering: numbering }
    );

    // 2 is not a number the message speaks, so the router read readerPages as
    // instructed and its answer stands.
    expect(intent.structuralEdit?.anchorPageIndex).toBe(2);
  });

  it("steps a 'before' anchor back after translating it, not before", () => {
    const intent = intentFromProposeEdit(
      // "before page 3" is the page the message names, position and all: a
      // router that sent 2 here would be sending a number the message never
      // speaks, and the guard would hand it straight through as a model index.
      proposeEdit({
        editTarget: "insert_pages",
        structuralAnchorPageIndex: 3,
        structuralAnchorPosition: "before",
        structuralPageCount: 1
      }),
      // No insert verb, so the deterministic recogniser reads nothing and the
      // anchor can only come from the router's own channel.
      "I'd like a new page ahead of page 3.",
      [],
      { pageNumbering: numbering }
    );

    // Printed 3 is physical 4, which is model page 2 — so the new page goes
    // after model page 1. Stepped back first it would have been printed 2,
    // which is model page 1, and the gap would open a whole page early.
    expect(intent.structuralEdit).toEqual({
      action: "insert",
      anchorPageIndex: 1,
      pageIndexes: [],
      pageCount: 1
    });
  });

  it("steps a 'before' anchor back on a book with no page map too", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({
        editTarget: "insert_pages",
        structuralAnchorPageIndex: 5,
        structuralAnchorPosition: "before",
        structuralPageCount: 2
      }),
      "I'd like two new pages ahead of page 5.",
      []
    );

    // Nothing to translate, so the step is the whole of the work: without it
    // the router's own number would land the pages on the wrong side.
    expect(intent.structuralEdit?.anchorPageIndex).toBe(4);
  });

  it("re-reads both halves of a move the router copied out of the message", () => {
    const intent = intentFromProposeEdit(
      // No move verb, so the deterministic recogniser reads nothing here and the
      // anchor can only come from the router's own channel.
      proposeEdit({ editTarget: "move_pages", pageIndexes: [4], structuralAnchorPageIndex: 2 }),
      "Page 4 should come after page 2.",
      [],
      { pageNumbering: numbering }
    );

    // A move is the request that always speaks two numbers, one in each channel.
    // Weighed apart neither channel holds the whole spoken set, so both used to
    // decline and the book was reordered by printed numbers: printed 4 is model
    // page 3, and printed 2 is model page 1.
    expect(intent.structuralEdit).toEqual({
      action: "move",
      anchorPageIndex: 1,
      pageIndexes: [3],
      pageCount: 0
    });
  });

  it("re-reads a 'before' destination on a move the same way", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({
        editTarget: "move_pages",
        pageIndexes: [4],
        structuralAnchorPageIndex: 2,
        structuralAnchorPosition: "before"
      }),
      "Page 4 should come before page 2.",
      [],
      { pageNumbering: numbering }
    );

    // Printed 4 is model page 3 and printed 2 is model page 1, so moving one
    // ahead of the other lands it at the head of the book.
    expect(intent.structuralEdit).toEqual({
      action: "move",
      anchorPageIndex: 0,
      pageIndexes: [3],
      pageCount: 0
    });
  });

  it("carries the pages of a delete through the same guard", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "delete_pages", pageIndexes: [4] }),
      "Delete page 4.",
      [],
      { pageNumbering: numbering }
    );

    expect(intent.structuralEdit).toMatchObject({ action: "delete", pageIndexes: [3] });
  });

  it("deletes only the pages the router named, never one it merely wrote an instruction for", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({
        editTarget: "delete_pages",
        pageIndexes: [4],
        perPageInstructions: [{ pageIndex: 2, instruction: "Make it shorter." }]
      }),
      "Delete page 4 and make page 2 shorter.",
      [],
      { pageNumbering: numbering }
    );

    // An instruction widens the *priced* set of a rewrite, because a page the
    // router wrote one for is a page it asked to edit. Here the routed set is
    // the selection itself, so the same widening would take a page out of the
    // book that the reader never asked to lose. Printed 4 is model page 3;
    // printed 2 is model page 1, and model page 1 must survive.
    expect(intent.structuralEdit).toEqual({
      action: "delete",
      anchorPageIndex: null,
      pageIndexes: [3],
      pageCount: 0
    });
  });

  it("moves only the pages the router named, on the same reasoning", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({
        editTarget: "move_pages",
        pageIndexes: [4],
        structuralAnchorPageIndex: 2,
        perPageInstructions: [{ pageIndex: 3, instruction: "Make it funnier." }]
      }),
      "Page 4 should come after page 2, and make page 3 funnier.",
      [],
      { pageNumbering: numbering }
    );

    // Printed 4 is model page 3 and printed 2 is model page 1. Widened, the
    // move would relocate model page 2 (printed 3) as well — a page the reader
    // named as prose to rewrite, not as one to travel.
    expect(intent.structuralEdit).toEqual({
      action: "move",
      anchorPageIndex: 1,
      pageIndexes: [3],
      pageCount: 0
    });
  });

  it("appends when the reader asked for the end and the router named no anchor", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_pages", structuralPageCount: 2 }),
      "Add two pages at the end of the book.",
      [],
      { pageNumbering: numbering }
    );

    // Null, not 0: this path has no page context, so the recogniser cannot
    // measure "the end" — and 0 is the front of the book, which is where these
    // two pages landed.
    expect(intent.structuralEdit).toEqual({
      action: "insert",
      anchorPageIndex: null,
      pageIndexes: [],
      pageCount: 2
    });
  });

  it("borrows the recogniser's anchor when both readings are the same edit", () => {
    const intent = intentFromProposeEdit(
      // No anchor channel at all: the router named the edit and left where it
      // goes to the message, which is the case the fallback exists for.
      proposeEdit({ editTarget: "insert_pages", structuralPageCount: 2 }),
      "Add two pages after page 3.",
      [],
      { pageNumbering: numbering }
    );

    // The recogniser reads printed 3 through the same map — physical 4, which
    // is model page 2 — so the borrowed anchor arrives as a model page like
    // any other.
    expect(intent.structuralEdit).toEqual({
      action: "insert",
      anchorPageIndex: 2,
      pageIndexes: [],
      pageCount: 2
    });
  });

  it("refuses to give a move the destination a recognised insert named", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "move_pages", pageIndexes: [1] }),
      // Two requests in one line, and the recogniser reads the other one: "put
      // a new page" is an insert whose destination is printed page 5, while
      // nothing here says where page 2 should end up.
      "Put a new page after page 5 and shuffle page 2 somewhere sensible.",
      [],
      { pageNumbering: numbering }
    );

    // Model page 3 is where the *new page* was to go. Borrowed across the two
    // readings it became the destination of a move nobody placed, and the card
    // would have shown and charged for that reorder.
    expect(intent.structuralEdit).toEqual({
      action: "move",
      anchorPageIndex: null,
      pageIndexes: [1],
      pageCount: 0
    });
    // Which lands on the "no place named" a move has always refused: free, and
    // answered with a sentence asking for the page the reader meant.
    const resolved = resolveStructuralPageEdit(intent.structuralEdit!, pages);
    expect(resolved.ok ? null : resolved.reason).toBe("anchor_out_of_range");
  });

  it("refuses to give a delete the destination a recognised insert named", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "delete_pages", pageIndexes: [1] }),
      // "take out the boring one" names no page, so the delete reading declines
      // and the recogniser answers with the *other* half of the line.
      "Add a page after page 5 and take out the boring one.",
      [],
      { pageNumbering: numbering }
    );

    // A delete has no destination — its own recognition always reports one as
    // null — so an anchor here can only have come from a reading of a different
    // request. `resolveStructuralPageEdit` ignores it for a delete, which is
    // exactly why it would have sat in the stored classifier unchallenged.
    expect(intent.structuralEdit).toEqual({
      action: "delete",
      anchorPageIndex: null,
      pageIndexes: [1],
      pageCount: 0
    });
  });

  it("has only an insert to lend this path, and that is a property of the call", () => {
    // The reachability behind the two tests above, pinned rather than reasoned
    // about. `intentFromProposeEdit` calls the recogniser with **no pages**, and
    // `pageIndexesFromMessage` filters its numbers against the pages it was
    // given — so the delete and move readings can never resolve one here, and a
    // move needs a source page to be a move at all. The only reading that comes
    // back anchored is therefore the insert, which is why the router's `move` and
    // `delete` targets are the two that could be handed a stranger's anchor.
    const context = numbering.pdfPageMap ? { pdfPageMap: numbering.pdfPageMap } : {};

    // Reads as a move with real pages in hand; here it falls through to "add a
    // page", whose anchor is the *move's* destination — printed 2, model page 1.
    expect(structuralPageEditFromMessage("Move page 4 to after page 2 and add a page too.", [], context)).toEqual({
      edit: { action: "insert", anchorPageIndex: 1, pageIndexes: [], pageCount: 1 },
      anchored: true
    });
    // The delete reading still wins the line, and it is unanchored: nothing to
    // borrow, whatever the router said. Give this call pages one day and both
    // readings gain an anchor to lend — the action gate is what covers that.
    expect(structuralPageEditFromMessage("Delete page 2 and add a page after page 5.", [], context)).toEqual({
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [], pageCount: 0 },
      anchored: false
    });
  });

  // What an insert's *count* does on this path — carried at the cap, refused
  // above it, and answered the same way as the model-free reading — is pinned
  // in `bookEditDecision.test.ts`, beside the clamp that used to sit there.
});

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

  it("puts a 'before' anchor ahead of the first model page of the sheet on both paths", () => {
    expect(structuralPageEditFromMessage("Add a page before page 10.", crowdedPages, context)?.edit).toMatchObject({
      action: "insert",
      anchorPageIndex: 6
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
    ).toEqual({ action: "insert", anchorPageIndex: 6, pageIndexes: [], pageCount: 1 });
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

  it("still refuses to write a page for a reorder that has nowhere to go", () => {
    // Printed 12 is model page 10, the book's last, so "at the end" is where it
    // already is: every source is the destination, the move declines, and the
    // insert reading must not pick it up — a numbered page is never a page to
    // write. That guard is what keeps a free reorder off a charged card, and it
    // survives the destination becoming a set.
    expect(structuralPageEditFromMessage("Put page 12 at the end", crowdedPages, context)).toBeNull();
    // The sheet's own pages, though, are a real thing to move: printed 10 is
    // model pages 7, 8 and 9, and none of them is the destination.
    expect(structuralPageEditFromMessage("Put page 10 at the end", crowdedPages, context)?.edit).toEqual({
      action: "move",
      anchorPageIndex: 10,
      pageIndexes: [7, 8, 9],
      pageCount: 0
    });
  });
});
