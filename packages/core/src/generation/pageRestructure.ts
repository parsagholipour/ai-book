import { z } from "zod";

/**
 * Inserting, deleting and reordering the pages of a finished book.
 *
 * Everything here is pure: what a request resolves to against the pages that
 * exist, and the durable record of what was done. Both halves are shared, and
 * for different reasons.
 *
 * The **resolution** is shared because the price and the work must agree. A
 * quote is computed from it at propose time and the same function runs again at
 * Apply, exactly as `continuationNewPageCount` already does for a continuation.
 *
 * The **record** is shared because the worker writes it and the API reads it:
 * a structural edit is applied in the worker and undone in the API, and the
 * only durable thing between them is `BookEditOperation.classifier`. That is
 * also the redelivery fence — it is written in the same transaction as the
 * index shift, so a job that finds it knows the shift already happened.
 */

export type StructuralPageAction = "insert" | "delete" | "move";

/**
 * Caps, in one place, because the router, the quote and the worker all have to
 * agree on them. The insert cap keeps a chat request from quietly becoming a
 * book-sized generation; the delete cap bounds the undo record, which carries
 * the removed pages' own prose (see {@link structuralApplicationSchema}).
 */
export const MAX_INSERTED_PAGES = 10;
export const MAX_DELETED_PAGES = 20;
export const MAX_MOVED_PAGES = 10;
/**
 * A pathological undo chain may have thousands of snapshots on one page. The
 * archive is durable database storage, but moving an unbounded history inside
 * the structural transaction would exhaust its time and memory budget. Refuse
 * before deleting anything instead of truncating history.
 */
export const MAX_STRUCTURAL_ARCHIVED_SNAPSHOTS = 1_000;

/** What the reader asked for, before it is resolved against the real book. */
export type StructuralPageEdit = {
  action: StructuralPageAction;
  /**
   * Insert and move: the page the new or moved pages land *after*.
   *
   * Three values, three meanings, and collapsing any two of them loses a real
   * request. A number is the page named. `0` is the head of the book — "write a
   * new opening page". `null` is *no place named at all*, which an insert
   * answers by appending (the commonest reading, and one the card states
   * plainly before anything is charged) and a move refuses, because a
   * destination is the whole of what a move is.
   */
  anchorPageIndex: number | null;
  /** Delete and move: which pages, in the reader's own order. */
  pageIndexes: number[];
  /** Insert: how many pages to write. */
  pageCount: number;
};

export type ExistingPage = {
  id: string;
  index: number;
  /**
   * Which chapter the page belongs to, when the book has chapters at all.
   *
   * Load-bearing for two reasons. Chapters are stored only as `Page.chapterId`
   * — the page range is not persisted — so a moved page that kept its old
   * chapter would interleave two chapters in the printed order. And a chapter
   * whose every page is deleted or moved away leaves a row with no pages, which
   * nothing downstream renumbers.
   */
  chapterId?: string | null;
};

export type PagePlacement = {
  pageId: string;
  index: number;
  /**
   * The chapter the page belongs to once the edit lands. Only ever differs
   * from the page's current chapter for a move, which re-homes the moved pages
   * into the chapter they now sit inside.
   */
  chapterId?: string | null;
};

/**
 * A resolved structural edit: exactly what to do to the rows.
 *
 * `pagesBilled` is the number the quote multiplies, and it is deliberately
 * *only* the pages a model has to write. Deleting and reordering pages calls no
 * provider at all, the same reasoning that prices `move_image` and
 * `remove_image` at zero.
 */
export type StructuralPagePlan = {
  action: StructuralPageAction;
  /** Insert only: where the gap opens, and the indexes the new pages take. */
  insertAfterIndex: number;
  newPageIndexes: number[];
  /** Delete only: the rows to remove, in index order. */
  removedPageIds: string[];
  /**
   * Delete and move: the whole project's page order afterwards. Empty for an
   * insert, which opens its gap with a shift instead — the new rows do not
   * exist yet, so there is nothing to name in an ordering.
   */
  order: PagePlacement[];
  /** Insert only: the chapter the new pages join. */
  newPageChapterId: string | null;
  /**
   * Every chapter's page count once this lands, keyed by chapter id.
   *
   * `Chapter.targetPages` and the plan's `chapters[].targetPages` are both
   * written from this: a compile calls `normalizePlanPageTargets`, so chapter
   * targets that no longer sum to the book's length silently re-partition the
   * chapters.
   */
  chapterPageCounts: Record<string, number>;
  /** The book's page count once this is applied. */
  totalPages: number;
  pagesBilled: number;
};

export type StructuralPageResolution =
  | { ok: true; plan: StructuralPagePlan }
  | { ok: false; reason: StructuralPageRefusal };

export type StructuralPageRefusal =
  | "no_pages"
  | "unknown_pages"
  | "anchor_out_of_range"
  | "nothing_to_do"
  | "too_many_pages"
  | "would_empty_book"
  | "would_empty_chapter"
  | "anchor_inside_selection"
  | "undo_history_too_large";

/**
 * Resolves a request against the pages the book actually has.
 *
 * Refusals are values rather than thrown errors because both callers answer
 * them in prose: the proposal turns one into a reply that says what it could
 * not find, and Apply turns one into a free settlement. Neither may charge for
 * an edit this function declined.
 */
export function resolveStructuralPageEdit(
  edit: StructuralPageEdit,
  pages: readonly ExistingPage[]
): StructuralPageResolution {
  const ordered = [...pages].sort((a, b) => a.index - b.index);
  if (ordered.length === 0) {
    return { ok: false, reason: "no_pages" };
  }
  const lastIndex = ordered[ordered.length - 1]!.index;
  const byIndex = new Map(ordered.map((page) => [page.index, page]));

  if (edit.action === "insert") {
    const count = Math.floor(edit.pageCount);
    if (count < 1) {
      return { ok: false, reason: "nothing_to_do" };
    }
    if (count > MAX_INSERTED_PAGES) {
      return { ok: false, reason: "too_many_pages" };
    }
    // An anchor past the end is an append, which is a real request ("add two
    // pages at the end"), so it clamps rather than refusing. Below zero is not.
    if (edit.anchorPageIndex !== null && edit.anchorPageIndex < 0) {
      return { ok: false, reason: "anchor_out_of_range" };
    }
    const afterIndex = edit.anchorPageIndex === null ? lastIndex : Math.min(edit.anchorPageIndex, lastIndex);
    // The new pages join the chapter they land inside — the anchor's, or the
    // first page's when they land at the head of the book.
    const host = afterIndex === 0 ? ordered[0] : byIndex.get(afterIndex);
    const newPageChapterId = host?.chapterId ?? null;
    const chapterPageCounts = chapterCounts(ordered);
    if (newPageChapterId !== null) {
      chapterPageCounts[newPageChapterId] = (chapterPageCounts[newPageChapterId] ?? 0) + count;
    }
    return {
      ok: true,
      plan: {
        action: "insert",
        insertAfterIndex: afterIndex,
        newPageIndexes: Array.from({ length: count }, (_value, offset) => afterIndex + offset + 1),
        removedPageIds: [],
        order: [],
        newPageChapterId,
        chapterPageCounts,
        totalPages: ordered.length + count,
        pagesBilled: count
      }
    };
  }

  const selected = [...new Set(edit.pageIndexes)].sort((a, b) => a - b);
  if (selected.length === 0) {
    return { ok: false, reason: "nothing_to_do" };
  }
  if (selected.some((index) => !byIndex.has(index))) {
    return { ok: false, reason: "unknown_pages" };
  }

  if (edit.action === "delete") {
    if (selected.length > MAX_DELETED_PAGES) {
      return { ok: false, reason: "too_many_pages" };
    }
    if (selected.length >= ordered.length) {
      // A book with no pages is not an edit, and every downstream check —
      // contiguity, the page-count match, the compile gate — would refuse it
      // later and more confusingly.
      return { ok: false, reason: "would_empty_book" };
    }
    const removed = new Set(selected);
    const survivors = ordered.filter((page) => !removed.has(page.index));
    // A chapter with no pages left is a row nothing renumbers and a heading
    // with nothing under it. Refusing says so; deleting the chapter would
    // invent chapter-renumbering semantics this project has nowhere else.
    if (emptiesAChapter(ordered, survivors)) {
      return { ok: false, reason: "would_empty_chapter" };
    }
    return {
      ok: true,
      plan: {
        action: "delete",
        insertAfterIndex: 0,
        newPageIndexes: [],
        removedPageIds: selected.map((index) => byIndex.get(index)!.id),
        order: renumbered(survivors),
        newPageChapterId: null,
        chapterPageCounts: chapterCounts(survivors),
        totalPages: survivors.length,
        pagesBilled: 0
      }
    };
  }

  if (selected.length > MAX_MOVED_PAGES) {
    return { ok: false, reason: "too_many_pages" };
  }
  // A move with no destination is not a move. There is no default worth
  // guessing: putting a page "somewhere" is a change the reader would have to
  // read the whole book to check.
  if (edit.anchorPageIndex === null || edit.anchorPageIndex < 0 || edit.anchorPageIndex > lastIndex) {
    return { ok: false, reason: "anchor_out_of_range" };
  }
  if (edit.anchorPageIndex > 0 && !byIndex.has(edit.anchorPageIndex)) {
    // A destination the book does not hold, which the range check above cannot
    // see: it only proves the anchor is not past the end. The insertion below
    // walks the pages that stay and drops the moved ones in when it reaches the
    // anchor, so an anchor nothing matches leaves them out of `order`
    // altogether — an `ok` plan whose ordering is short of its own
    // `totalPages`, which renumbers the survivors and leaves the moved pages
    // sitting on the indexes the survivors just took. `pageIndexes` is checked
    // against the book for the same reason (`unknown_pages`).
    return { ok: false, reason: "anchor_out_of_range" };
  }
  if (selected.includes(edit.anchorPageIndex)) {
    // "Move pages 4 and 5 to after page 4" names a destination that is itself
    // moving, so the request has no fixed point to land on.
    return { ok: false, reason: "anchor_inside_selection" };
  }
  const moving = new Set(selected);
  const staying = ordered.filter((page) => !moving.has(page.index));
  // The moved pages join the chapter they land inside, or the first chapter
  // when they land at the head. Keeping their old chapter would print two
  // chapters interleaved, because a chapter is only its pages' `chapterId` —
  // the page range is stored nowhere.
  // `undefined` means the caller does not track chapters at all, which is not
  // the same as a page that belongs to none — re-homing on the first would
  // invent a chapter column the book never had.
  //
  // At the head that first chapter is `ordered[0]`'s **even when `ordered[0]`
  // is itself one of the moving pages**: `selected` is sorted, so a moving
  // first page leads the block and is still the book's first page afterwards.
  // Reading it off the first page that *stays* looks safer and is not — "move
  // pages 1, 2 and 4 to the front" of a book whose chapter 1 is pages 1-2 would
  // re-home all three into chapter 2 and then refuse the whole request as
  // `would_empty_chapter`, over a chapter only that re-homing emptied.
  const destinationChapterId =
    edit.anchorPageIndex === 0 ? ordered[0]?.chapterId : byIndex.get(edit.anchorPageIndex)?.chapterId;
  const movedPages = selected.map((index) => {
    const page = byIndex.get(index)!;
    return destinationChapterId === undefined ? page : { ...page, chapterId: destinationChapterId };
  });
  const rearranged: ExistingPage[] = [];
  if (edit.anchorPageIndex === 0) {
    rearranged.push(...movedPages, ...staying);
  } else {
    for (const page of staying) {
      rearranged.push(page);
      if (page.index === edit.anchorPageIndex) {
        rearranged.push(...movedPages);
      }
    }
  }
  const order = renumbered(rearranged);
  if (order.every((placement, offset) => placement.pageId === ordered[offset]?.id)) {
    // Already where it was asked to go. Applying it would delete the exports,
    // bump the revision, recompile an identical book and report a change.
    return { ok: false, reason: "nothing_to_do" };
  }
  if (emptiesAChapter(ordered, rearranged)) {
    return { ok: false, reason: "would_empty_chapter" };
  }
  return {
    ok: true,
    plan: {
      action: "move",
      insertAfterIndex: 0,
      newPageIndexes: [],
      removedPageIds: [],
      order,
      newPageChapterId: null,
      chapterPageCounts: chapterCounts(rearranged),
      totalPages: ordered.length,
      pagesBilled: 0
    }
  };
}

function renumbered(pages: readonly ExistingPage[]): PagePlacement[] {
  return pages.map((page, offset) => ({
    pageId: page.id,
    index: offset + 1,
    ...(page.chapterId === undefined ? {} : { chapterId: page.chapterId })
  }));
}

/**
 * A plan re-fitted to the pages the book has now, or the refusal that re-fitting
 * it produced.
 *
 * `drifted` says whether anything had to move, so a caller can say so in a log
 * without diffing two plans itself — and it is also the switch: a plan nothing
 * had to repair is handed back **as it came in**, object and all. This is a
 * repair rather than a recomputation: nothing is re-derived for a plan that
 * still describes the book, which is what stops an ordinary edit being written
 * from a second derivation of its own shape.
 *
 * **"Nothing had to move" therefore has to include the chapter distribution.**
 * `drifted: false` is a promise that the returned object *is* the argument, so
 * every field the caller reads off it has to have been checked — and
 * `chapterPageCounts` is read by the caller twice, into `Chapter.targetPages`
 * and into the plan of the `PlanVersion` it writes beside them. It went
 * unchecked on the insert path, so a page that changed chapters in the window
 * (a structural move, or the undo of one — neither changes the book's length,
 * its indexes or the anchor's host chapter) came back as a plan "nothing had to
 * repair" carrying the distribution the book had *before* that move, and the
 * compile then walked those targets cumulatively and printed a chapter heading
 * a page off. Comparing them is not a second opinion of what a chapter count is:
 * both sides are {@link chapterCounts} of the read they were resolved against,
 * so a difference is only ever the later read seeing a different book.
 */
export type StructuralPlanReconciliation =
  | { ok: true; plan: StructuralPagePlan; drifted: boolean }
  | { ok: false; reason: StructuralPageRefusal };

/**
 * The resolved plan, held to the pages the project actually has at the moment
 * the shift is about to run.
 *
 * {@link resolveStructuralPageEdit} answers against a read taken well before
 * that. The quote runs it at propose time and the worker runs it again at Apply,
 * and even the Apply's copy is read outside the transaction that moves the rows
 * — the plan-version reads, the provider construction and the transaction's own
 * start all sit between the two. Anything that creates or deletes a `Page` in
 * that window (a continuation's crash compensation, a manual-edit path, the
 * stray host worker sharing the Docker stack's queue) leaves the plan describing
 * a book that is no longer there, and `pageOrderStatements` has no tolerance for
 * that: it requires a list naming **every** page of the project, because pass
 * two brings every parked row back at once. A live page the list leaves out
 * keeps a positive index a parked row may be about to land on — `23505` when
 * they collide, and a silent hole in `1..N` when they miss, which nothing
 * notices until a compile refuses the book for not being contiguous from 1. A
 * page the list *names* and the book has lost leaves the same hole from the
 * other side, because its placement matches no row and the index it claimed is
 * skipped.
 *
 * The undo side has never trusted its recorded order for exactly these reasons
 * (`restoredPageOrder`, `packages/db/src/pageRestructureRevert.ts`), and this is
 * the same reconciliation on the apply side, in the same shape: the pages the
 * plan names go back in the plan's own sequence, pages the plan never saw keep
 * their order behind them, pages the plan names but the book has lost are
 * dropped, and the whole list is renumbered from 1 — a no-op for a book that did
 * not drift, because a resolved order already runs `1..n`. Two copies of a
 * compensation is how the two ends of the queue start disagreeing about the same
 * row, and two *different answers* to "where does a page nobody named belong" is
 * the same bug wearing a different hat, so the tail is the answer on both sides.
 * The tail is also the honest one: appending is how a page arrives on a finished
 * book — `continueBook` is the path — and a page that arrived mid-book from a
 * second structural edit is put at the end rather than left to collide, which is
 * a wrong position instead of an unreadable book.
 *
 * **The plan is reconciled, never re-resolved.** Re-running the resolver under
 * the lock looks like the obvious fix and is the wrong one: a request names page
 * *indexes* while a plan names page *ids*, so a page inserted ahead of the
 * selection makes "delete page 3" resolve to a page the card never confirmed.
 * Ids are what survive a renumber — it is why the stamp records them — so ids
 * are what this holds.
 *
 * Refusing is still right where no re-fitting produces a book. The guards the
 * resolver applied to the stale read are applied again to the live one, and a
 * refusal here settles exactly as a refusal there does: free, marked
 * `structuralSkipped`, with the charge handed back.
 */
export function reconcileStructuralPagePlan(
  plan: StructuralPagePlan,
  pages: readonly ExistingPage[]
): StructuralPlanReconciliation {
  const live = [...pages].sort((left, right) => left.index - right.index);
  if (live.length === 0) {
    return { ok: false, reason: "no_pages" };
  }
  return plan.action === "insert" ? reconciledInsert(plan, live) : reconciledOrdering(plan, live);
}

/**
 * An insert is index-shaped rather than id-shaped, which is why it needs less of
 * this and not none of it.
 *
 * The gap is opened by `shiftPageIndexes`, which moves whatever now sits after
 * the anchor and cannot collide with a page that arrived or left in the window.
 * The anchor itself is the exposed half. `resolveStructuralPageEdit` clamps one
 * past the end to the last page, because "add two pages at the end" is a real
 * request; a book that lost pages under the card leaves that same anchor past
 * the *new* end, and then the shift moves nothing while `createMany` writes the
 * new pages at indexes no survivor reaches — a book numbered 1, 2, 3, 11, 12,
 * the same invisible hole the ordering path leaves. So the clamp is re-applied,
 * and the new pages' indexes come off the clamped anchor.
 *
 * The host chapter is re-read for a reason of its own: a chapter is stored only
 * as its pages' `chapterId`, so new pages joining the chapter of whichever page
 * *used* to hold the anchor index is how two chapters end up interleaved in the
 * printed order.
 *
 * **And the whole distribution is re-measured with it, because an insert writes
 * no page's chapter and so cannot make the book agree with a stale one.** The
 * ordering path names every page's chapter in `order` and `pagesToRehome` writes
 * those rows, so the counts it hands back describe the book it is about to
 * produce whether or not it re-fitted anything. An insert only ever sets the
 * chapter of the rows it creates: the live membership of every page that
 * already exists stands, so the live read is the only true measurement, and the
 * plan's copy is right exactly while it still matches. When it does not — a
 * page moved between chapters in the window, which moves neither the book's
 * length nor the anchor — the caller would otherwise write the stale
 * distribution into `Chapter.targetPages` and the new `PlanVersion`, and
 * `chapterStartsForPages` walks those targets cumulatively from page 1.
 */
function reconciledInsert(
  plan: StructuralPagePlan,
  live: readonly ExistingPage[]
): StructuralPlanReconciliation {
  const count = plan.newPageIndexes.length;
  if (count < 1) {
    return { ok: false, reason: "nothing_to_do" };
  }
  const lastIndex = live[live.length - 1]!.index;
  const insertAfterIndex = Math.min(plan.insertAfterIndex, lastIndex);
  const host = insertAfterIndex === 0 ? live[0] : live.find((page) => page.index === insertAfterIndex);
  // `undefined` from either side means "this ordering does not track chapters",
  // which is not the same as a page belonging to none — so the plan's own answer
  // stands rather than being overwritten with a null the book never had.
  const newPageChapterId = host === undefined || host.chapterId === undefined ? plan.newPageChapterId : host.chapterId;
  // `undefined` on every page is a read that does not track chapters at all —
  // the distinction `newPageChapterId` turns on one line above — and it is not
  // a book whose pages belong to none. Measuring `{}` off such a read and
  // handing it on would be `planWithChapterTargets`'s *unmeasured* case, which
  // re-partitions every chapter target rather than keeping the ones the
  // resolver did measure.
  const measuresChapters = live.some((page) => page.chapterId !== undefined);
  const measured = chapterCounts(live);
  if (measuresChapters && newPageChapterId !== null) {
    measured[newPageChapterId] = (measured[newPageChapterId] ?? 0) + count;
  }
  const chapterPageCounts = measuresChapters ? measured : plan.chapterPageCounts;
  const totalPages = live.length + count;
  if (
    insertAfterIndex === plan.insertAfterIndex &&
    totalPages === plan.totalPages &&
    newPageChapterId === plan.newPageChapterId &&
    sameChapterCounts(chapterPageCounts, plan.chapterPageCounts)
  ) {
    return { ok: true, plan, drifted: false };
  }
  return {
    ok: true,
    plan: {
      ...plan,
      insertAfterIndex,
      newPageIndexes: Array.from({ length: count }, (_value, offset) => insertAfterIndex + offset + 1),
      newPageChapterId,
      chapterPageCounts,
      totalPages
    },
    drifted: true
  };
}

/**
 * The delete and move half, which is the one `applyPageOrder` reads.
 *
 * `pagesBilled` is deliberately left alone: it is what the reader was charged,
 * and a delete or a move is charged nothing, so nothing here can move a price.
 * `totalPages` and `chapterPageCounts` are recomputed because the `PlanVersion`
 * written beside them carries the book's new length in its `inputSnapshot` — a
 * plan that disagrees with the pages is `PAGE_COUNT_MISMATCH` at compile time,
 * and every printed chapter heading walks those targets cumulatively.
 */
function reconciledOrdering(
  plan: StructuralPagePlan,
  live: readonly ExistingPage[]
): StructuralPlanReconciliation {
  const liveById = new Map(live.map((page) => [page.id, page]));
  // A page somebody else already deleted is a delete that is partly done, not a
  // delete that failed: `deleteMany` would tolerate the dead id, but the undo
  // record read alongside it would not, and neither would the ordering.
  const removedPageIds = plan.removedPageIds.filter((pageId) => liveById.has(pageId));
  if (plan.action === "delete" && removedPageIds.length === 0) {
    return { ok: false, reason: "nothing_to_do" };
  }
  const removed = new Set(removedPageIds);
  const named = [...plan.order]
    .filter((placement) => liveById.has(placement.pageId) && !removed.has(placement.pageId))
    .sort((left, right) => left.index - right.index);
  const namedPageIds = new Set(named.map((placement) => placement.pageId));
  const gained = live.filter((page) => !namedPageIds.has(page.id) && !removed.has(page.id));
  const sequence: { pageId: string; chapterId?: string | null }[] = [
    ...named.map((placement) => ({
      pageId: placement.pageId,
      ...(placement.chapterId === undefined ? {} : { chapterId: placement.chapterId })
    })),
    ...gained.map((page) => ({
      pageId: page.id,
      ...(page.chapterId === undefined ? {} : { chapterId: page.chapterId })
    }))
  ];
  if (sequence.length === 0) {
    // Everything the plan would keep has gone and everything left is being
    // removed. The resolver refuses this against its own read for the reason it
    // refuses it here: every downstream check would refuse an empty book later
    // and more confusingly.
    return { ok: false, reason: "would_empty_book" };
  }
  const order: PagePlacement[] = sequence.map((entry, offset) => ({ ...entry, index: offset + 1 }));
  if (plan.action === "move" && order.every((placement, offset) => placement.pageId === live[offset]?.id)) {
    // The book drifted into the shape this move was asking for. Applying it
    // would delete the exports, bump the revision and recompile an identical
    // book while reporting a change — the resolver's own `nothing_to_do`.
    return { ok: false, reason: "nothing_to_do" };
  }
  const after: ExistingPage[] = order.map((placement) => {
    const held = liveById.get(placement.pageId)?.chapterId;
    const chapterId = placement.chapterId === undefined ? held : placement.chapterId;
    return { id: placement.pageId, index: placement.index, ...(chapterId === undefined ? {} : { chapterId }) };
  });
  if (emptiesAChapter(live, after)) {
    return { ok: false, reason: "would_empty_chapter" };
  }
  const drifted =
    order.length !== plan.order.length ||
    removedPageIds.length !== plan.removedPageIds.length ||
    order.some((placement, offset) => {
      const planned = plan.order[offset];
      return planned === undefined || planned.pageId !== placement.pageId || planned.index !== placement.index;
    });
  if (!drifted) {
    return { ok: true, plan, drifted: false };
  }
  return {
    ok: true,
    plan: { ...plan, removedPageIds, order, chapterPageCounts: chapterCounts(after), totalPages: order.length },
    drifted: true
  };
}

/**
 * Where every page's index lands once this plan is applied, keyed by the index
 * it holds now.
 *
 * `Page.index` is a position rather than an identity, and two things outside
 * the `Page` table are keyed on it: the semantic-memory scopes
 * (`repointPageEmbeddings`) and `Project.pdfPageMap`, which stays in force for
 * as long as the reader is looking at the export this edit has not rebuilt yet.
 * Both re-point through this rather than each deriving the shift again — an
 * insert moves the tail without naming it in an ordering, so the two actions
 * genuinely compute it differently.
 *
 * A removed page is **absent**, which is how a caller tells "this moved" from
 * "whatever you keyed on this index is gone". Inserted pages are not here
 * either: nothing outside the table can be pointing at an index that did not
 * exist a moment ago.
 */
export function pageIndexMovesForStructuralPlan(
  plan: StructuralPagePlan,
  pagesBefore: readonly { id: string; index: number }[]
): Map<number, number> {
  const moves = new Map<number, number>();
  if (plan.action === "insert") {
    const delta = plan.newPageIndexes.length;
    for (const page of pagesBefore) {
      moves.set(page.index, page.index > plan.insertAfterIndex ? page.index + delta : page.index);
    }
    return moves;
  }
  const indexById = new Map(pagesBefore.map((page) => [page.id, page.index]));
  for (const placement of plan.order) {
    const before = indexById.get(placement.pageId);
    if (before !== undefined) {
      moves.set(before, placement.index);
    }
  }
  return moves;
}

function chapterCounts(pages: readonly ExistingPage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const page of pages) {
    if (page.chapterId) {
      counts[page.chapterId] = (counts[page.chapterId] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Whether two chapter distributions describe the same book.
 *
 * Both sides are built by {@link chapterCounts}, so this compares one function's
 * answer over two reads rather than two opinions of what a chapter count is —
 * which is why a difference is the *book* having moved and not this module
 * second-guessing the resolver. A chapter absent from one side is a chapter with
 * no pages, and no writer of this record ever stores a zero.
 */
function sameChapterCounts(left: Record<string, number>, right: Record<string, number>): boolean {
  const chapterIds = Object.keys(left);
  if (chapterIds.length !== Object.keys(right).length) {
    return false;
  }
  return chapterIds.every((chapterId) => left[chapterId] === right[chapterId]);
}

function emptiesAChapter(before: readonly ExistingPage[], after: readonly ExistingPage[]): boolean {
  const remaining = chapterCounts(after);
  return Object.keys(chapterCounts(before)).some((chapterId) => (remaining[chapterId] ?? 0) === 0);
}

/**
 * A page taken out of the book, kept whole so undo can put it back.
 *
 * It cannot live in a `PageEditSnapshot`: that row is `onDelete: Cascade` on
 * `Page`, so snapshotting a page and then deleting it destroys the snapshot in
 * the same statement. The image undo already restores from the classifier this
 * way, so the pattern is the established one rather than a new mechanism.
 */
export const removedPageRecordSchema = z.object({
  id: z.string(),
  index: z.number().int().positive(),
  chapterId: z.string().nullable(),
  title: z.string(),
  markdown: z.string(),
  summary: z.string(),
  imagePrompt: z.string().nullable(),
  revision: z.number().int().positive(),
  storyDelta: z.unknown().optional(),
  // The page's own generation state, which undo has to put back rather than
  // invent. All three are optional for one reason only: stamps written before
  // they joined the record carry none of them, and the revert's original
  // behaviour — an approved page with no report and no image failure — is what
  // those legacy stamps must keep restoring. A new stamp always names `status`.
  //
  // `status` because a `FAILED_QA` page coming back `COMPLETED` silently
  // approves prose the reviewer refused; `qualityReport` because it is the
  // reason that verdict gives; and `imageFailureReason` because it is not only
  // a display marker — `projectAlreadyIllustrated` reads it to decide whether a
  // free-tier illustrated-book slot has already been consumed, so a book that
  // loses its last one can claim a second slot in the same month.
  status: z.string().min(1).optional(),
  qualityReport: z.unknown().optional(),
  imageFailureReason: z.string().nullable().optional(),
  imageAssetIds: z.array(z.string()).default([])
});

export type RemovedPageRecord = z.infer<typeof removedPageRecordSchema>;

/**
 * The bounded pointer to snapshots parked outside their deleted Page rows.
 * Snapshot bodies stay in the database rather than inflating the operation's
 * JSON classifier; the count lets revert detect a missing or partial archive
 * before it changes a page.
 */
export const structuralSnapshotArchiveSchema = z.object({
  key: z.string().min(1).max(200),
  snapshotCount: z.number().int().positive().max(MAX_STRUCTURAL_ARCHIVED_SNAPSHOTS)
});

/**
 * The stamp written in the same transaction as the index shift.
 *
 * It is three things at once, and each is why it is written where it is:
 * the **redelivery fence** (its presence means the shift already ran, so a
 * second delivery resumes instead of shifting twice), the **resume pointer**
 * (page *ids*, so drafting continues against the right rows however the
 * indexes moved), and the **undo record**.
 */
export const structuralApplicationSchema = z.object({
  action: z.enum(["insert", "delete", "move"]),
  /** The order and chapter every page held before this edit; undo restores both wholesale. */
  pageOrderBefore: z.array(
    z.object({
      pageId: z.string(),
      index: z.number().int().positive(),
      // Optional only for stamps written before chapter membership joined the
      // undo record. Treating a missing value as null would move those legacy
      // pages out of their chapters when the reader taps Undo.
      chapterId: z.string().nullable().optional()
    })
  ),
  insertedPageIds: z.array(z.string()).default([]),
  removedPages: z.array(removedPageRecordSchema).default([]),
  // Optional for every stamp written before snapshot preservation existed.
  snapshotArchive: structuralSnapshotArchiveSchema.optional(),
  basePlanVersionId: z.string().nullable().default(null),
  newPlanVersionId: z.string().nullable().default(null),
  previousTargetPages: z.number().int().positive(),
  previousChapterTargetPages: z.record(z.string(), z.number().int()).default({}),
  /**
   * Project revision whose manuscript the shift was derived from. Optional for
   * stamps written before cancellation compensation gained a revision fence.
   */
  baseContentRevision: z.number().int().nonnegative().optional(),
  appliedAt: z.string()
});

export type StructuralApplication = z.infer<typeof structuralApplicationSchema>;

/** Reads the stamp off a `BookEditOperation.classifier`, or null. */
export function parseStructuralApplication(classifier: unknown): StructuralApplication | null {
  if (typeof classifier !== "object" || classifier === null) {
    return null;
  }
  const raw = (classifier as Record<string, unknown>).structuralApplication;
  if (raw === undefined || raw === null) {
    return null;
  }
  const parsed = structuralApplicationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Reads the request off a `BookEditOperation.classifier`, or null. */
export function structuralEditFromClassifier(classifier: unknown): StructuralPageEdit | null {
  if (typeof classifier !== "object" || classifier === null) {
    return null;
  }
  const parsed = structuralPageEditSchema.safeParse((classifier as Record<string, unknown>).structuralEdit);
  return parsed.success ? parsed.data : null;
}

export const structuralPageEditSchema = z.object({
  action: z.enum(["insert", "delete", "move"]),
  anchorPageIndex: z.number().int().min(0).nullable().default(null),
  pageIndexes: z.array(z.number().int().positive()).default([]),
  pageCount: z.number().int().min(0).default(0)
});
