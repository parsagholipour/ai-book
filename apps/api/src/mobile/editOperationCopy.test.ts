import { describe, expect, it } from "vitest";
import { MODEL_PAGE_NUMBERING, numberingForProject } from "../bookPageNumbering.js";
import { currentActionForEditOperation } from "./editOperationCopy.js";
import { type MobileBookEditOperationRecord } from "./dto.js";

/**
 * The book the map below describes has a cover and a Contents, so printed page
 * 2 is model page 1 — the divergence every card here has to survive.
 *
 * These ranges are what an insert of two pages after model page 1 leaves
 * behind: the apply re-points the stored map over the shift, so the pages that
 * already existed keep their (still true) ranges under their new indexes, and
 * the two pages just written appear nowhere in it. They cannot: the file the
 * map was measured from does not contain them yet.
 *
 * Model page 1 is deliberately three printed sheets long (2–4). A model page is
 * a *range*, so the number a reader calls it by and the number something lands
 * after it on are two different sheets, and the anchor is the only page on the
 * card with a translation at all — printing the near end of its span put the
 * new pages two sheets ahead of where they were written.
 */
const repointedMapAfterInsert = {
  version: 2,
  totalPdfPages: 10,
  hasCoverPage: true,
  contentsStartPdfPage: 2,
  pages: [
    { index: 1, startPdfPage: 3, endPdfPage: 5 },
    { index: 4, startPdfPage: 5, endPdfPage: 6 },
    { index: 5, startPdfPage: 7, endPdfPage: 9 }
  ],
  contentRevision: 7
};

/** The project is EDITING until the recompile publishes, which keeps that map in force. */
const numberingDuringEdit = numberingForProject({
  pdfPageMap: repointedMapAfterInsert,
  contentRevision: 8,
  status: "EDITING"
});

function appliedRestructure(
  structuralEdit: Record<string, unknown>,
  affectedPageIndexes: number[],
  application?: Record<string, unknown>
): MobileBookEditOperationRecord {
  return {
    id: "op-1",
    projectId: "project-1",
    kind: "RESTRUCTURE_PAGES",
    status: "APPLIED",
    request: "Add 2 pages after page 2.",
    classifier: { structuralEdit, ...(application ? { structuralApplication: application } : {}) },
    affectedPageIndexes,
    creditsCharged: 60,
    createdAt: new Date("2026-08-16T00:00:00.000Z"),
    appliedAt: new Date("2026-08-16T00:01:00.000Z")
  };
}

describe("currentActionForEditOperation for an applied insert", () => {
  it("names how many pages and which printed page they follow, never the new model indexes", () => {
    const operation = appliedRestructure(
      { action: "insert", anchorPageIndex: 1, pageIndexes: [], pageCount: 2 },
      // The two pages the worker wrote, as model indexes. The map has no range
      // for either — and 2 and 3 are the printed numbers of model page 1, so
      // rendering them as page numbers pointed the reader at the wrong sheet.
      [2, 3],
      { action: "insert", insertedPageIds: ["page-a", "page-b"] }
    );

    // The mechanism, so the card can never be built on it again: the map cannot
    // translate a page it has never seen, and hands the model index back.
    expect(numberingDuringEdit.displayPages([2, 3])).toEqual([2, 3]);
    expect(numberingDuringEdit.displayPages([1])).toEqual([2, 3, 4]);
    // The far end of the anchor's span, because that is the last sheet holding
    // text the new pages come after. The near end (2) is the number the reader
    // calls that page by, and naming it would promise the new pages two sheets
    // earlier than they were written.
    expect(numberingDuringEdit.displayPage(1)).toBe(2);
    expect(numberingDuringEdit.displayPageEnd(1)).toBe(4);
    expect(currentActionForEditOperation(operation, numberingDuringEdit)).toBe(
      "2 new pages added after page 4."
    );
  });

  it("says the front of the book for anchor 0 and the end for no anchor at all", () => {
    expect(
      currentActionForEditOperation(
        appliedRestructure({ action: "insert", anchorPageIndex: 0, pageIndexes: [], pageCount: 1 }, [1]),
        numberingDuringEdit
      )
    ).toBe("1 new page added at the front of the book.");
    expect(
      currentActionForEditOperation(
        appliedRestructure({ action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 3 }, [6, 7, 8]),
        numberingDuringEdit
      )
    ).toBe("3 new pages added at the end of the book.");
  });

  it("speaks model indexes when the book has no translatable map, as every other card does", () => {
    expect(
      currentActionForEditOperation(
        appliedRestructure({ action: "insert", anchorPageIndex: 1, pageIndexes: [], pageCount: 2 }, [2, 3]),
        MODEL_PAGE_NUMBERING
      )
    ).toBe("2 new pages added after page 1.");
  });

  it("adds no location for an anchor the classifier does not carry", () => {
    expect(
      currentActionForEditOperation(appliedRestructure({ action: "insert" }, [4]), numberingDuringEdit)
    ).toBe("1 new page added.");
  });

  it("claims no pages for an insert that settled having written none", () => {
    // A skipped apply is refunded and writes nothing, so the requested
    // `pageCount` may not be read as a count of pages the book now has.
    expect(
      currentActionForEditOperation(
        appliedRestructure({ action: "insert", anchorPageIndex: 1, pageIndexes: [], pageCount: 2 }, []),
        numberingDuringEdit
      )
    ).toBe("New pages added.");
  });

  it("leaves delete and move reporting what they did", () => {
    expect(
      currentActionForEditOperation(
        appliedRestructure({ action: "delete", anchorPageIndex: null, pageIndexes: [3], pageCount: 0 }, []),
        numberingDuringEdit
      )
    ).toBe("Pages removed.");
    expect(
      currentActionForEditOperation(
        appliedRestructure({ action: "move", anchorPageIndex: 2, pageIndexes: [1], pageCount: 0 }, []),
        numberingDuringEdit
      )
    ).toBe("Pages moved.");
  });

  /**
   * The row `restructurePages` writes when the resolver refuses: the charge
   * handed back, the operation APPLIED, and nothing done to the book — so the
   * only thing separating it from a real edit is the marker.
   */
  function skippedRestructure(
    structuralEdit: Record<string, unknown>,
    reason: string
  ): MobileBookEditOperationRecord {
    return {
      ...appliedRestructure(structuralEdit, []),
      classifier: { structuralEdit, structuralSkipped: reason }
    };
  }

  // The worker cannot write a chat message, so the card is the one surface that
  // can correct the queued reply's promise — and for a delivered no-op it was
  // confirming it instead.
  it("says a structural edit the worker declined changed nothing", () => {
    const deleted = { action: "delete", anchorPageIndex: null, pageIndexes: [9], pageCount: 0 };
    // Without the marker the same row reads as a delete that happened, which is
    // exactly what the reader was being told about a book that lost no page.
    expect(currentActionForEditOperation(appliedRestructure(deleted, []), numberingDuringEdit)).toBe(
      "Pages removed."
    );

    const summary = currentActionForEditOperation(
      skippedRestructure(deleted, "unknown_pages"),
      numberingDuringEdit
    );
    expect(summary).toBe("Nothing was changed: those pages aren’t in the book any more.");
    // The refund travels as `creditsRefunded`; no chat surface names a price.
    expect(summary).not.toMatch(/credit/i);
  });

  it("tells a move what stopped it, the way the layout fork does", () => {
    const moved = { action: "move", anchorPageIndex: 2, pageIndexes: [1], pageCount: 0 };
    expect(currentActionForEditOperation(skippedRestructure(moved, "nothing_to_do"), numberingDuringEdit)).toBe(
      "Nothing was changed: those pages are already where you asked for them."
    );
    expect(
      currentActionForEditOperation(skippedRestructure(moved, "anchor_out_of_range"), numberingDuringEdit)
    ).toBe("Nothing was changed: the page they were meant to follow isn’t in the book any more.");
  });

  it("keeps the specific refusals specific and the rest general", () => {
    const deleted = { action: "delete", anchorPageIndex: null, pageIndexes: [4, 5], pageCount: 0 };
    expect(
      currentActionForEditOperation(skippedRestructure(deleted, "would_empty_book"), numberingDuringEdit)
    ).toBe("Nothing was changed: that would have taken out every page of the book.");
    expect(
      currentActionForEditOperation(skippedRestructure(deleted, "would_empty_chapter"), numberingDuringEdit)
    ).toBe("Nothing was changed: that would have left one of the chapters with no pages.");
    // An insert has no page of its own to name and a book with none is the
    // refusal it meets, so the general sentence answers it — never the
    // requested `pageCount` reported as pages the book now has.
    expect(
      currentActionForEditOperation(
        skippedRestructure({ action: "insert", anchorPageIndex: 1, pageIndexes: [], pageCount: 2 }, "no_pages"),
        numberingDuringEdit
      )
    ).toBe("Nothing was changed: the book had moved on before that edit ran.");
  });

  it("still says what it is doing while the pages are being written", () => {
    const queued = {
      ...appliedRestructure({ action: "insert", anchorPageIndex: 1, pageIndexes: [], pageCount: 2 }, []),
      status: "APPLYING",
      appliedAt: null
    };
    expect(currentActionForEditOperation(queued, numberingDuringEdit)).toBe("Writing the new pages.");
  });
});

/**
 * An insert that created five pages and wrote fewer of them.
 *
 * `stampDescribesBook` resumes a delivery on a partial survival on purpose —
 * the survivors sit at indexes the tail was already shifted for, so re-applying
 * would shift it again and insert a duplicate set beside them — and
 * `refundUnwrittenEditPages` hands back the pages nobody will read. What
 * settles is therefore an APPLIED row whose `affectedPageIndexes` is a *part*
 * of the run the stamp records, and the card read the anchor off the lowest of
 * them: one less than the first page written is the head of the run only when
 * the whole run is there, and otherwise a page of the insert itself or the gap
 * one left behind. Neither exists in the map in force, so the number reached
 * the reader as a raw model index wearing a printed page's clothes.
 */
describe("an applied insert that wrote fewer pages than it created", () => {
  /**
   * The map as the apply leaves it: measured from the PDF *before* the insert
   * and re-pointed over the shift, so the two pages that already existed keep
   * their true ranges under their new indexes (2 and 3 became 7 and 8) and
   * every index between them is a page this edit made, which the file the map
   * describes does not contain.
   *
   * Model page 1 is deliberately six printed sheets long, so the sheet the new
   * pages follow (7) is a number no page of the insert shares.
   */
  const repointedMapAcrossTheGap = {
    version: 2,
    totalPdfPages: 10,
    hasCoverPage: true,
    contentsStartPdfPage: 2,
    pages: [
      { index: 1, startPdfPage: 3, endPdfPage: 8 },
      { index: 7, startPdfPage: 9, endPdfPage: 9 },
      { index: 8, startPdfPage: 10, endPdfPage: 10 }
    ],
    contentRevision: 11
  };
  /** EDITING until the recompile publishes, which is what keeps that map in force. */
  const numbering = numberingForProject({
    pdfPageMap: repointedMapAcrossTheGap,
    contentRevision: 12,
    status: "EDITING"
  });
  const afterPageOne = { action: "insert", anchorPageIndex: 1, pageIndexes: [], pageCount: 5 };
  /** The stamp the shift wrote: five page rows created, ids and all. */
  const fivePagesCreated = {
    action: "insert",
    insertedPageIds: ["page-a", "page-b", "page-c", "page-d", "page-e"]
  };

  it("names the anchor's last printed sheet when every recorded page was written", () => {
    const summary = currentActionForEditOperation(
      appliedRestructure(afterPageOne, [2, 3, 4, 5, 6], fivePagesCreated),
      numbering
    );
    // The anchor is a page that already existed, so it is the one page on this
    // card the map can still place — at its far end, because that is the sheet
    // the new prose follows.
    expect(numbering.printedPageEnd(1)).toBe(7);
    expect(summary).toBe("5 new pages added after page 7.");
  });

  it("names no page at all when only the tail of the insert survived", () => {
    // Five ids recorded, two pages drafted: the rest were gone by the time the
    // resumed delivery looked for them, and the difference was refunded.
    const summary = currentActionForEditOperation(
      appliedRestructure(afterPageOne, [5, 6], fivePagesCreated),
      numbering
    );

    // The mechanism, so the card can never be derived from it again: one less
    // than the first page written is index 4, which this book's map has never
    // seen — and the number it falls back to is a printed page 4 the reader can
    // turn to, holding something else entirely.
    expect(numbering.displayPageEnd(4)).toBe(4);
    expect(numbering.printedPageEnd(4)).toBeUndefined();
    expect(summary).toBe("2 new pages added.");
    expect(summary).not.toMatch(/after page/);
    // The count is the whole claim, so no page number of any kind is in it.
    expect(summary).not.toMatch(/page \d/);
  });

  it("keeps the request's own front and end whatever the delivery wrote", () => {
    // Neither phrase is derived from the pages: `0` survives the resolver's
    // clamp untouched and `null` is clamped to the last page, so both are true
    // of the book the apply landed on however much of the run it went on to
    // write.
    expect(
      currentActionForEditOperation(
        appliedRestructure(
          { action: "insert", anchorPageIndex: 0, pageIndexes: [], pageCount: 5 },
          [4, 5],
          fivePagesCreated
        ),
        numbering
      )
    ).toBe("2 new pages added at the front of the book.");
    expect(
      currentActionForEditOperation(
        appliedRestructure(
          { action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 5 },
          [11, 12],
          fivePagesCreated
        ),
        numbering
      )
    ).toBe("2 new pages added at the end of the book.");
  });

  it("leaves the place out when the map in force cannot place the anchor", () => {
    // A whole insert, written after a page an *earlier* edit added to a book
    // whose recompile has not published: the anchor is a real page the reader
    // has, and the map measured from the file on screen has no sheet for it.
    const summary = currentActionForEditOperation(
      appliedRestructure({ action: "insert", anchorPageIndex: 4, pageIndexes: [], pageCount: 2 }, [5, 6], {
        action: "insert",
        insertedPageIds: ["page-a", "page-b"]
      }),
      numbering
    );
    expect(summary).toBe("2 new pages added.");
    expect(summary).not.toMatch(/page \d/);
  });
});
