import { describe, expect, it } from "vitest";
import {
  MAX_DELETED_PAGES,
  MAX_INSERTED_PAGES,
  MAX_STRUCTURAL_ARCHIVED_SNAPSHOTS,
  pageIndexMovesForStructuralPlan,
  parseStructuralApplication,
  reconcileStructuralPagePlan,
  resolveStructuralPageEdit,
  structuralEditFromClassifier,
  type ExistingPage,
  type StructuralPageEdit
} from "./pageRestructure.js";

const book = (count: number): ExistingPage[] =>
  Array.from({ length: count }, (_value, offset) => ({ id: `page-${offset + 1}`, index: offset + 1 }));

const edit = (overrides: Partial<StructuralPageEdit>): StructuralPageEdit => ({
  action: "insert",
  anchorPageIndex: 0,
  pageIndexes: [],
  pageCount: 0,
  ...overrides
});

const resolve = (overrides: Partial<StructuralPageEdit>, pages = book(6)) =>
  resolveStructuralPageEdit(edit(overrides), pages);

describe("resolving an insert", () => {
  it("takes the indexes right after the anchor", () => {
    const resolved = resolve({ action: "insert", anchorPageIndex: 3, pageCount: 2 });

    expect(resolved).toEqual({
      ok: true,
      plan: {
        action: "insert",
        insertAfterIndex: 3,
        newPageIndexes: [4, 5],
        removedPageIds: [],
        order: [],
        newPageChapterId: null,
        chapterPageCounts: {},
        totalPages: 8,
        pagesBilled: 2
      }
    });
  });

  it("treats anchor 0 as the head of the book", () => {
    const resolved = resolve({ action: "insert", anchorPageIndex: 0, pageCount: 1 });

    expect(resolved.ok && resolved.plan.newPageIndexes).toEqual([1]);
  });

  it("clamps an anchor past the end into an append", () => {
    // "Add two pages at the end" of a six-page book is a real request, and
    // refusing it would send it back through the whole-book widening.
    const resolved = resolve({ action: "insert", anchorPageIndex: 99, pageCount: 2 });

    expect(resolved.ok && resolved.plan.newPageIndexes).toEqual([7, 8]);
  });

  it("refuses more pages than one chat edit may write", () => {
    expect(resolve({ action: "insert", anchorPageIndex: 1, pageCount: MAX_INSERTED_PAGES + 1 })).toEqual({
      ok: false,
      reason: "too_many_pages"
    });
  });

  it("bills only the pages a model has to write", () => {
    const resolved = resolve({ action: "insert", anchorPageIndex: 1, pageCount: 3 });

    expect(resolved.ok && resolved.plan.pagesBilled).toBe(3);
  });
});

describe("resolving a delete", () => {
  it("renumbers the survivors contiguously from 1", () => {
    const resolved = resolve({ action: "delete", pageIndexes: [2, 5] });

    expect(resolved.ok && resolved.plan.removedPageIds).toEqual(["page-2", "page-5"]);
    expect(resolved.ok && resolved.plan.order).toEqual([
      { pageId: "page-1", index: 1 },
      { pageId: "page-3", index: 2 },
      { pageId: "page-4", index: 3 },
      { pageId: "page-6", index: 4 }
    ]);
    expect(resolved.ok && resolved.plan.totalPages).toBe(4);
  });

  it("costs nothing, because no model is asked anything", () => {
    const resolved = resolve({ action: "delete", pageIndexes: [2] });

    expect(resolved.ok && resolved.plan.pagesBilled).toBe(0);
  });

  it("refuses to empty the book", () => {
    expect(resolve({ action: "delete", pageIndexes: [1, 2, 3] }, book(3))).toEqual({
      ok: false,
      reason: "would_empty_book"
    });
  });

  it("refuses a page the book does not have", () => {
    expect(resolve({ action: "delete", pageIndexes: [2, 99] })).toEqual({ ok: false, reason: "unknown_pages" });
  });

  it("caps the delete, because undo carries the removed pages' own prose", () => {
    const pages = book(MAX_DELETED_PAGES + 5);
    const selected = pages.slice(0, MAX_DELETED_PAGES + 1).map((page) => page.index);

    expect(resolveStructuralPageEdit(edit({ action: "delete", pageIndexes: selected }), pages)).toEqual({
      ok: false,
      reason: "too_many_pages"
    });
  });
});

describe("resolving a move", () => {
  it("lands the moved pages right after the anchor", () => {
    const resolved = resolve({ action: "move", pageIndexes: [5], anchorPageIndex: 1 });

    expect(resolved.ok && resolved.plan.order).toEqual([
      { pageId: "page-1", index: 1 },
      { pageId: "page-5", index: 2 },
      { pageId: "page-2", index: 3 },
      { pageId: "page-3", index: 4 },
      { pageId: "page-4", index: 5 },
      { pageId: "page-6", index: 6 }
    ]);
    expect(resolved.ok && resolved.plan.pagesBilled).toBe(0);
  });

  it("moves a page forwards", () => {
    const resolved = resolve({ action: "move", pageIndexes: [2], anchorPageIndex: 4 });

    expect(resolved.ok && resolved.plan.order.map((placement) => placement.pageId)).toEqual([
      "page-1",
      "page-3",
      "page-4",
      "page-2",
      "page-5",
      "page-6"
    ]);
  });

  it("moves pages to the head of the book", () => {
    const resolved = resolve({ action: "move", pageIndexes: [4, 5], anchorPageIndex: 0 });

    expect(resolved.ok && resolved.plan.order.map((placement) => placement.pageId)).toEqual([
      "page-4",
      "page-5",
      "page-1",
      "page-2",
      "page-3",
      "page-6"
    ]);
  });

  it("refuses a destination that is itself moving", () => {
    // "Move pages 4 and 5 to after page 4" has no fixed point to land on.
    expect(resolve({ action: "move", pageIndexes: [4, 5], anchorPageIndex: 4 })).toEqual({
      ok: false,
      reason: "anchor_inside_selection"
    });
  });

  it("refuses a destination the book does not hold rather than dropping the moved pages", () => {
    // The range check only ever proved the anchor was not past the end, so an
    // index no page holds walked the whole ordering without matching and left
    // the moved pages out of `order` — an `ok` plan two pages short of its own
    // `totalPages`, which renumbers the survivors onto the indexes the moved
    // pages are still sitting on.
    const gapped: ExistingPage[] = [1, 2, 4, 5].map((index) => ({ id: `page-${index}`, index }));

    expect(
      resolveStructuralPageEdit(edit({ action: "move", pageIndexes: [1], anchorPageIndex: 3 }), gapped)
    ).toEqual({ ok: false, reason: "anchor_out_of_range" });
  });

  it("refuses a move that changes nothing rather than bumping the revision", () => {
    // Page 4 already sits right after page 3, so this would delete the exports,
    // recompile an identical book and tell the reader something changed.
    expect(resolve({ action: "move", pageIndexes: [4], anchorPageIndex: 3 })).toEqual({
      ok: false,
      reason: "nothing_to_do"
    });
  });
});

describe("where each page's index lands", () => {
  const movesFor = (overrides: Partial<StructuralPageEdit>) => {
    const resolved = resolve(overrides);
    if (!resolved.ok) {
      throw new Error(`expected a plan, got ${resolved.reason}`);
    }
    return pageIndexMovesForStructuralPlan(resolved.plan, book(6));
  };

  it("shifts only the tail of an insert, which names no ordering of its own", () => {
    expect([...movesFor({ action: "insert", anchorPageIndex: 3, pageCount: 2 })]).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 6],
      [5, 7],
      [6, 8]
    ]);
  });

  it("leaves a deleted page out, so a caller can tell 'moved' from 'gone'", () => {
    const moves = movesFor({ action: "delete", pageIndexes: [2] });

    expect(moves.has(2)).toBe(false);
    expect([...moves]).toEqual([
      [1, 1],
      [3, 2],
      [4, 3],
      [5, 4],
      [6, 5]
    ]);
  });

  it("reads a move straight off the ordering", () => {
    expect([...movesFor({ action: "move", pageIndexes: [5], anchorPageIndex: 1 })]).toEqual([
      [1, 1],
      [5, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [6, 6]
    ]);
  });
});

describe("chapters, which are only ever their pages' chapterId", () => {
  // Two chapters of three pages each. The page range is stored nowhere, so
  // every chapter question here is answered from membership alone.
  const chaptered: ExistingPage[] = book(6).map((page) => ({
    ...page,
    chapterId: page.index <= 3 ? "chapter-1" : "chapter-2"
  }));

  it("puts inserted pages in the chapter they land inside and grows its count", () => {
    const resolved = resolveStructuralPageEdit(
      edit({ action: "insert", anchorPageIndex: 5, pageCount: 2 }),
      chaptered
    );

    expect(resolved.ok && resolved.plan.newPageChapterId).toBe("chapter-2");
    expect(resolved.ok && resolved.plan.chapterPageCounts).toEqual({ "chapter-1": 3, "chapter-2": 5 });
  });

  it("puts pages inserted at the head in the first chapter", () => {
    const resolved = resolveStructuralPageEdit(
      edit({ action: "insert", anchorPageIndex: 0, pageCount: 1 }),
      chaptered
    );

    expect(resolved.ok && resolved.plan.newPageChapterId).toBe("chapter-1");
  });

  it("re-homes a moved page into the chapter it now sits in", () => {
    // Keeping page 5's own chapter would print chapter 2 inside chapter 1.
    const resolved = resolveStructuralPageEdit(
      edit({ action: "move", pageIndexes: [5], anchorPageIndex: 1 }),
      chaptered
    );

    expect(resolved.ok && resolved.plan.order[1]).toEqual({
      pageId: "page-5",
      index: 2,
      chapterId: "chapter-1"
    });
    expect(resolved.ok && resolved.plan.chapterPageCounts).toEqual({ "chapter-1": 4, "chapter-2": 2 });
  });

  it("keeps a head move in the first chapter when the first page is itself moving", () => {
    // The whole of chapter 1 is in the moving set, so the destination chapter
    // is read off a page that is moving — and that is right: sorted, page 1
    // leads the block and is still the book's first page, so the block is the
    // first chapter. Reading it off page 4, the first page that stays, would
    // re-home pages 1-3 into chapter 2 and refuse the request for emptying a
    // chapter that nothing but that re-homing emptied.
    const resolved = resolveStructuralPageEdit(
      edit({ action: "move", pageIndexes: [1, 2, 3, 5], anchorPageIndex: 0 }),
      chaptered
    );

    expect(resolved.ok && resolved.plan.order).toEqual([
      { pageId: "page-1", index: 1, chapterId: "chapter-1" },
      { pageId: "page-2", index: 2, chapterId: "chapter-1" },
      { pageId: "page-3", index: 3, chapterId: "chapter-1" },
      { pageId: "page-5", index: 4, chapterId: "chapter-1" },
      { pageId: "page-4", index: 5, chapterId: "chapter-2" },
      { pageId: "page-6", index: 6, chapterId: "chapter-2" }
    ]);
    expect(resolved.ok && resolved.plan.chapterPageCounts).toEqual({ "chapter-1": 4, "chapter-2": 2 });
  });

  it("refuses a delete that would leave a chapter with no pages", () => {
    expect(
      resolveStructuralPageEdit(edit({ action: "delete", pageIndexes: [4, 5, 6] }), chaptered)
    ).toEqual({ ok: false, reason: "would_empty_chapter" });
  });

  it("refuses a move that would empty the chapter it left", () => {
    expect(
      resolveStructuralPageEdit(edit({ action: "move", pageIndexes: [4, 5, 6], anchorPageIndex: 1 }), chaptered)
    ).toEqual({ ok: false, reason: "would_empty_chapter" });
  });

  it("leaves a book with no chapters alone", () => {
    const resolved = resolve({ action: "move", pageIndexes: [5], anchorPageIndex: 1 });

    expect(resolved.ok && resolved.plan.order[1]).toEqual({ pageId: "page-5", index: 2 });
    expect(resolved.ok && resolved.plan.chapterPageCounts).toEqual({});
  });
});

/**
 * The window between the read a plan was resolved against and the read the
 * shift is written from.
 *
 * `applyStructuralPageChange` claims the operation row and then reads the pages,
 * but the plan in its hand was resolved before any of that — the quote's read at
 * propose time, the Apply's own read before the plan-version reads and the
 * transaction's start. Anything that creates or deletes a `Page` in that window
 * leaves the plan describing a book that is no longer there, and
 * `pageOrderStatements` has no tolerance for it: the list must name **every**
 * page of the project or a parked row lands on an index a live page still holds
 * (`23505`) or misses it and leaves a hole in `1..N`.
 */
describe("holding a resolved plan to the book the shift actually finds", () => {
  /** The pipeline as it really runs: resolve against one read, re-fit to another. */
  const refit = (request: Partial<StructuralPageEdit>, before: ExistingPage[], live: ExistingPage[]) => {
    const resolved = resolveStructuralPageEdit(edit(request), before);
    if (!resolved.ok) {
      throw new Error(`the request did not resolve: ${resolved.reason}`);
    }
    return { planned: resolved.plan, refitted: reconcileStructuralPagePlan(resolved.plan, live) };
  };

  /** The ordering as `pageId@index`, which is all `applyPageOrder` reads of it. */
  const placements = (result: ReturnType<typeof reconcileStructuralPagePlan>): string[] =>
    result.ok ? result.plan.order.map((placement) => `${placement.pageId}@${placement.index}`) : [];

  /** The same book with a page taken out and the survivors renumbered. */
  const without = (pages: ExistingPage[], pageId: string): ExistingPage[] =>
    pages.filter((page) => page.id !== pageId).map((page, offset) => ({ ...page, index: offset + 1 }));

  const chaptered = (): ExistingPage[] =>
    book(6).map((page) => ({ ...page, chapterId: page.index <= 3 ? "chapter-1" : "chapter-2" }));

  it("hands back the very plan it was given when the book did not move", () => {
    const { planned, refitted } = refit({ action: "delete", pageIndexes: [2] }, book(6), book(6));

    // Identity, not equality. This is a repair rather than a recomputation: a
    // plan nothing had to fix must not have this function's opinion of a book's
    // chapter counts laid over the resolver's for every ordinary edit.
    expect(refitted).toEqual({ ok: true, plan: planned, drifted: false });
    expect(refitted.ok && refitted.plan).toBe(planned);
  });

  it("drops a placement naming a page the book has lost and closes the gap", () => {
    const shrunk = without(book(6), "page-4");

    const { refitted } = refit({ action: "move", pageIndexes: [5], anchorPageIndex: 1 }, book(6), shrunk);

    expect(placements(refitted)).toEqual(["page-1@1", "page-5@2", "page-2@3", "page-3@4", "page-6@5"]);
    expect(refitted.ok && refitted.plan.totalPages).toBe(5);
    expect(refitted.ok && refitted.drifted).toBe(true);
  });

  it("puts a page nobody named at the tail, which is the answer the undo side gives", () => {
    // A continuation appended it, which is the only way a page arrives on a
    // finished book without a stamp — and `restoredPageOrder` puts one exactly
    // here. Two different answers to "where does a page nobody named belong" is
    // how the two ends of the queue start disagreeing about the same row.
    const grown = [...book(6), { id: "page-7", index: 7 }];

    const { refitted } = refit({ action: "delete", pageIndexes: [2] }, book(6), grown);

    expect(placements(refitted)).toEqual(["page-1@1", "page-3@2", "page-4@3", "page-5@4", "page-6@5", "page-7@6"]);
    expect(refitted.ok && refitted.plan.totalPages).toBe(6);
  });

  it("keeps a delete somebody else has half-performed rather than failing it", () => {
    const { refitted } = refit({ action: "delete", pageIndexes: [2, 3] }, book(6), without(book(6), "page-2"));

    // `deleteMany` would tolerate the dead id, but the undo record read beside
    // it would not: a removed-page record for a row this transaction never took
    // puts back a page somebody else deliberately removed.
    expect(refitted.ok && refitted.plan.removedPageIds).toEqual(["page-3"]);
    expect(placements(refitted)).toEqual(["page-1@1", "page-4@2", "page-5@3", "page-6@4"]);
  });

  it("refuses a delete whose every page has already gone", () => {
    const { refitted } = refit({ action: "delete", pageIndexes: [2] }, book(6), without(book(6), "page-2"));

    // Nothing left to do, so nothing is written and the caller settles it free —
    // rather than bumping the revision and recompiling an unchanged book.
    expect(refitted).toEqual({ ok: false, reason: "nothing_to_do" });
  });

  it("refuses when everything the plan meant to keep has gone", () => {
    const survivors: ExistingPage[] = [
      { id: "page-5", index: 1 },
      { id: "page-6", index: 2 }
    ];

    const { refitted } = refit({ action: "delete", pageIndexes: [5, 6] }, book(6), survivors);

    expect(refitted).toEqual({ ok: false, reason: "would_empty_book" });
  });

  it("refuses a book that has no pages left at all", () => {
    const { refitted } = refit({ action: "move", pageIndexes: [5], anchorPageIndex: 1 }, book(6), []);

    expect(refitted).toEqual({ ok: false, reason: "no_pages" });
  });

  it("refuses a move the drift has already performed", () => {
    const moved: ExistingPage[] = ["page-1", "page-5", "page-2", "page-3", "page-4", "page-6"].map((id, offset) => ({
      id,
      index: offset + 1
    }));

    const { refitted } = refit({ action: "move", pageIndexes: [5], anchorPageIndex: 1 }, book(6), moved);

    expect(refitted).toEqual({ ok: false, reason: "nothing_to_do" });
  });

  it("refuses a re-fit that would leave a chapter with no pages", () => {
    // The resolver let this through because chapter 2 still kept page 6. Page 6
    // went in the window, so re-homing pages 4 and 5 into chapter 1 now empties
    // chapter 2 — a heading with nothing under it and a row nothing renumbers.
    const { refitted } = refit(
      { action: "move", pageIndexes: [4, 5], anchorPageIndex: 1 },
      chaptered(),
      without(chaptered(), "page-6")
    );

    expect(refitted).toEqual({ ok: false, reason: "would_empty_chapter" });
  });

  it("re-clamps an insert whose anchor outran a book that shrank", () => {
    // The resolver clamps an anchor past the end because "add two pages at the
    // end" is a real request. A shorter book leaves that clamp past the *new*
    // end, and then the shift moves nothing while the new pages are created at
    // indexes no survivor reaches — a book numbered 1, 2, 3, 4, 7, 8.
    const { refitted } = refit({ action: "insert", anchorPageIndex: 6, pageCount: 2 }, book(6), book(4));

    expect(refitted.ok && refitted.plan.insertAfterIndex).toBe(4);
    expect(refitted.ok && refitted.plan.newPageIndexes).toEqual([5, 6]);
    expect(refitted.ok && refitted.plan.totalPages).toBe(6);
    // What the reader was charged, which no re-fit may move: the pages a model
    // has to write is still two.
    expect(refitted.ok && refitted.plan.pagesBilled).toBe(2);
  });

  it("reads an insert's host chapter off whichever page holds the anchor index now", () => {
    // A chapter is stored only as its pages' `chapterId`, so new pages joining
    // the chapter of the page that *used* to hold this index is how two chapters
    // end up interleaved in the printed order.
    const { planned, refitted } = refit(
      { action: "insert", anchorPageIndex: 3, pageCount: 1 },
      chaptered(),
      without(chaptered(), "page-3")
    );

    expect(planned.newPageChapterId).toBe("chapter-1");
    expect(refitted.ok && refitted.plan.newPageChapterId).toBe("chapter-2");
    expect(refitted.ok && refitted.plan.chapterPageCounts).toEqual({ "chapter-1": 2, "chapter-2": 4 });
  });

  it("re-measures an insert's chapter distribution when a page changed chapters under it", () => {
    // A move (or the undo of one) landing in the window moves no page *count*:
    // the book is the same length, the anchor index still exists and the page
    // now holding it is still in the same chapter — so nothing the anchor,
    // total and host chapter can see has changed. What did change is which
    // chapter every page belongs to, and an insert writes no existing page's
    // `chapterId`, so the live read is the only true measurement. Handing the
    // plan's copy back writes it into `Chapter.targetPages` and the new
    // `PlanVersion`, and `chapterStartsForPages` walks those cumulatively from
    // page 1 — a chapter heading printed a page off.
    const afterAMove: ExistingPage[] = [
      { id: "page-1", index: 1, chapterId: "chapter-1" },
      { id: "page-2", index: 2, chapterId: "chapter-1" },
      { id: "page-4", index: 3, chapterId: "chapter-2" },
      { id: "page-5", index: 4, chapterId: "chapter-2" },
      // Moved out of chapter 1 and re-homed, which is what `pagesToRehome` does.
      { id: "page-3", index: 5, chapterId: "chapter-2" },
      { id: "page-6", index: 6, chapterId: "chapter-2" }
    ];

    const insert = { action: "insert" as const, anchorPageIndex: 5, pageCount: 1 };
    const { planned, refitted } = refit(insert, chaptered(), afterAMove);

    expect(planned.chapterPageCounts).toEqual({ "chapter-1": 3, "chapter-2": 4 });
    expect(refitted.ok && refitted.plan.chapterPageCounts).toEqual({ "chapter-1": 2, "chapter-2": 5 });
    // Everything the old equality test compared is unchanged: this drift is
    // visible in the distribution and nowhere else.
    expect(refitted.ok && refitted.plan.insertAfterIndex).toBe(planned.insertAfterIndex);
    expect(refitted.ok && refitted.plan.newPageIndexes).toEqual(planned.newPageIndexes);
    expect(refitted.ok && refitted.plan.newPageChapterId).toBe("chapter-2");
    expect(refitted.ok && refitted.plan.totalPages).toBe(planned.totalPages);
    // Still what the reader was charged: a re-fit may not move a price.
    expect(refitted.ok && refitted.plan.pagesBilled).toBe(1);
    expect(refitted.ok && refitted.drifted).toBe(true);
  });

  it("hands an insert back untouched when the book is still the one it was resolved against", () => {
    // The identity return is the switch, so comparing the distribution may not
    // turn an ordinary insert into a re-derivation of its own plan.
    const withChapters = refit({ action: "insert", anchorPageIndex: 5, pageCount: 2 }, chaptered(), chaptered());
    const plain = refit({ action: "insert", anchorPageIndex: 3, pageCount: 2 }, book(6), book(6));

    expect(withChapters.refitted).toEqual({ ok: true, plan: withChapters.planned, drifted: false });
    expect(withChapters.refitted.ok && withChapters.refitted.plan).toBe(withChapters.planned);
    expect(plain.refitted).toEqual({ ok: true, plan: plain.planned, drifted: false });
    expect(plain.refitted.ok && plain.refitted.plan).toBe(plain.planned);
  });

  it("keeps the plan's counts when the live read does not track chapters at all", () => {
    // `undefined` is a caller that carries no chapter column, which is not a
    // book whose pages belong to none — the same distinction the host chapter
    // turns on. Measuring `{}` off it would be the *unmeasured* case, where
    // every chapter target is re-partitioned instead of kept.
    const { planned, refitted } = refit({ action: "insert", anchorPageIndex: 5, pageCount: 1 }, chaptered(), book(6));

    expect(planned.chapterPageCounts).toEqual({ "chapter-1": 3, "chapter-2": 4 });
    expect(refitted.ok && refitted.plan.chapterPageCounts).toEqual(planned.chapterPageCounts);
    expect(refitted.ok && refitted.plan.newPageChapterId).toBe("chapter-2");
    expect(refitted.ok && refitted.drifted).toBe(false);
  });
});

describe("the durable record", () => {
  it("reads a stamp back off a classifier", () => {
    const stamp = {
      action: "insert",
      pageOrderBefore: [{ pageId: "page-1", index: 1, chapterId: "chapter-1" }],
      insertedPageIds: ["page-new"],
      previousTargetPages: 6,
      appliedAt: "2026-08-15T00:00:00.000Z"
    };

    expect(parseStructuralApplication({ structuralApplication: stamp })).toMatchObject({
      action: "insert",
      insertedPageIds: ["page-new"],
      pageOrderBefore: [{ pageId: "page-1", index: 1, chapterId: "chapter-1" }],
      removedPages: [],
      previousChapterTargetPages: {}
    });
    expect(parseStructuralApplication({ structuralApplication: stamp })).not.toHaveProperty("snapshotArchive");
  });

  it("reads a bounded snapshot archive pointer without putting snapshot bodies in the stamp", () => {
    const parsed = parseStructuralApplication({
      structuralApplication: {
        action: "delete",
        pageOrderBefore: [{ pageId: "page-1", index: 1 }],
        removedPages: [],
        snapshotArchive: { key: "operation-structural", snapshotCount: 3 },
        previousTargetPages: 1,
        appliedAt: "2026-08-15T00:00:00.000Z"
      }
    });

    expect(parsed?.snapshotArchive).toEqual({ key: "operation-structural", snapshotCount: 3 });
  });

  it("rejects an unbounded snapshot archive rather than half-reading its redelivery stamp", () => {
    expect(
      parseStructuralApplication({
        structuralApplication: {
          action: "delete",
          pageOrderBefore: [{ pageId: "page-1", index: 1 }],
          snapshotArchive: {
            key: "operation-structural",
            snapshotCount: MAX_STRUCTURAL_ARCHIVED_SNAPSHOTS + 1
          },
          previousTargetPages: 1,
          appliedAt: "2026-08-15T00:00:00.000Z"
        }
      })
    ).toBeNull();
  });

  it("keeps a legacy stamp readable without inventing chapter membership", () => {
    const parsed = parseStructuralApplication({
      structuralApplication: {
        action: "move",
        pageOrderBefore: [{ pageId: "page-1", index: 1 }],
        previousTargetPages: 1,
        appliedAt: "2026-08-15T00:00:00.000Z"
      }
    });

    expect(parsed?.pageOrderBefore).toEqual([{ pageId: "page-1", index: 1 }]);
    expect(parsed?.pageOrderBefore[0]).not.toHaveProperty("chapterId");
  });

  it("keeps a removed page's own state, and invents none for a stamp that predates it", () => {
    const removedPage = {
      id: "page-2",
      index: 2,
      chapterId: null,
      title: "Two",
      markdown: "Body.",
      summary: "Summary.",
      imagePrompt: null,
      revision: 2
    };
    const stamp = (page: Record<string, unknown>) => ({
      structuralApplication: {
        action: "delete",
        pageOrderBefore: [{ pageId: "page-2", index: 2 }],
        removedPages: [page],
        previousTargetPages: 2,
        appliedAt: "2026-08-19T00:00:00.000Z"
      }
    });

    const qualityReport = { approved: false, issues: ["Repeats page 1."] };
    expect(
      parseStructuralApplication(
        stamp({ ...removedPage, status: "FAILED_QA", qualityReport, imageFailureReason: "no provider drew it" })
      )?.removedPages[0]
    ).toMatchObject({ status: "FAILED_QA", qualityReport, imageFailureReason: "no provider drew it" });
    // Undo history already stored carries none of the three, and the revert's
    // original defaults are the only honest answer for it — so the schema must
    // leave them absent rather than supply one.
    const legacy = parseStructuralApplication(stamp(removedPage))?.removedPages[0];
    expect(legacy).not.toHaveProperty("status");
    expect(legacy).not.toHaveProperty("qualityReport");
    expect(legacy).not.toHaveProperty("imageFailureReason");
  });

  it("reads nothing rather than half a stamp", () => {
    // A malformed stamp must not read as "the shift already happened": the
    // fence would skip a shift that never ran, and undo would restore an order
    // the book never had.
    expect(parseStructuralApplication({})).toBeNull();
    expect(parseStructuralApplication(null)).toBeNull();
    expect(parseStructuralApplication({ structuralApplication: { action: "insert" } })).toBeNull();
  });

  it("reads the request back for a resumed apply", () => {
    expect(
      structuralEditFromClassifier({ structuralEdit: { action: "insert", anchorPageIndex: 3, pageCount: 2 } })
    ).toEqual({ action: "insert", anchorPageIndex: 3, pageIndexes: [], pageCount: 2 });
    expect(structuralEditFromClassifier({ kind: "page_rewrite" })).toBeNull();
  });
});
