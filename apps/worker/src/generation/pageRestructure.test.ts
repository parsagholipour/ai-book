import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  bookPlanSchema,
  resolveStructuralPageEdit,
  type BookPlan,
  type CreateProjectInput,
  type PagePlacement,
  type StructuralApplication,
  type StructuralPageEdit,
  type StructuralPagePlan
} from "@book-maker/core";
const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const track = <T>(name: string, result: T) =>
    vi.fn(async () => {
      order.push(name);
      return result;
    });
  return {
    order,
    track,
    prisma: {
      $transaction: vi.fn()
    },
    applyPageOrder: track("applyPageOrder", undefined),
    shiftPageIndexes: track("shiftPageIndexes", undefined),
    repointPageContinuityNotes: track("repointPageContinuityNotes", undefined),
    repointPageEmbeddings: track("repointPageEmbeddings", undefined),
    deletePageContinuityNotes: track("deletePageContinuityNotes", undefined),
    deletePageEmbeddings: track("deletePageEmbeddings", undefined),
    discardLegacyPageContinuityNotes: track("discardLegacyPageContinuityNotes", undefined),
    repointedPageMapUpdate: vi.fn(() => ({})),
    leaseClaim: {
      outcome: "acquired",
      phase: "draft",
      application: null,
      expiresAt: new Date("2026-08-17T00:03:00.000Z")
    } as Record<string, unknown>,
    acquireStructuralPageLeaseTx: vi.fn(async () => {
      order.push("bookEditOperation.updateMany");
      return mocks.leaseClaim;
    }),
    nextPlanVersion: vi.fn(async () => 4),
    planInputSnapshot: vi.fn((input: CreateProjectInput) => input as unknown)
  };
});
vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  applyPageOrder: mocks.applyPageOrder,
  shiftPageIndexes: mocks.shiftPageIndexes,
  repointPageContinuityNotes: mocks.repointPageContinuityNotes,
  repointPageEmbeddings: mocks.repointPageEmbeddings,
  deletePageContinuityNotes: mocks.deletePageContinuityNotes,
  deletePageEmbeddings: mocks.deletePageEmbeddings,
  discardLegacyPageContinuityNotes: mocks.discardLegacyPageContinuityNotes,
  repointedPageMapUpdate: mocks.repointedPageMapUpdate
}));
vi.mock("./bookHelpers.js", () => ({
  nextPlanVersion: mocks.nextPlanVersion,
  planInputSnapshot: mocks.planInputSnapshot
}));
vi.mock("./structuralPageLease.js", () => ({
  acquireStructuralPageLeaseTx: mocks.acquireStructuralPageLeaseTx
}));
import { applyStructuralPageChange } from "./pageRestructure.js";
/**
 * A four-page book; the plans below all act on it.
 *
 * It is what the *transaction's* own read answers, never a fixture the caller
 * carried in — `applyStructuralPageChange` reads the pages under the operation
 * row's claim, and every number it writes is derived from that read.
 */
const pagesBefore = [
  { id: "page-1", index: 1 },
  { id: "page-2", index: 2 },
  { id: "page-3", index: 3 },
  { id: "page-4", index: 4 }
];
const plan = (overrides: Partial<StructuralPagePlan> = {}): StructuralPagePlan => {
  const totalPages = overrides.totalPages ?? 4;
  return {
    action: "delete",
    insertAfterIndex: 0,
    newPageIndexes: [],
    removedPageIds: [],
    order: [],
    newPageChapterId: null,
    // The fixture book is one chapter holding every page, so the book's own
    // length is that chapter's measured count. The cases below are not about
    // the rebalance, and a count that already explains the whole book is what
    // keeps them out of it.
    chapterPageCounts: { "chapter-1": totalPages },
    totalPages,
    pagesBilled: 0,
    ...overrides
  };
};
/** The smallest thing `bookPlanSchema` accepts, with the chapters under test. */
const bookPlan = (targets: number[]): BookPlan =>
  bookPlanSchema.parse({
    title: "A Book",
    premise: "A premise.",
    audience: "Everyone",
    writingComplexity: 5,
    voiceGuide: ["Warm."],
    antiAiRules: ["No filler."],
    chapters: targets.map((targetPages, offset) => ({
      index: offset + 1,
      title: `Chapter ${offset + 1}`,
      summary: "Summary.",
      targetPages
    })),
    illustrationPlan: { globalStyle: "Ink." }
  });

type CreatedPlanVersion = { data: { planningPackage: BookPlan; inputSnapshot: { targetPages: number } } };
/** The plan version the transaction wrote, as the arguments it was written with. */
const createdPlanVersion = (tx: ReturnType<typeof transaction>): CreatedPlanVersion =>
  (tx.planVersion.create.mock.calls as unknown as CreatedPlanVersion[][])[0]![0]!;

const chapterTargetsOf = (tx: ReturnType<typeof transaction>): number[] =>
  createdPlanVersion(tx).data.planningPackage.chapters.map((chapter) => chapter.targetPages);
/**
 * The ordering `applyPageOrder` was handed, which is what the race cases below
 * rest on: `pageOrderStatements` requires a list naming **every** page of the
 * project, because pass two brings every parked row back at once — a live page
 * left out keeps a positive index a parked row may land on (`23505`), and a
 * silent hole in `1..N` where they miss.
 */
const writtenPageOrder = (): PagePlacement[] =>
  (mocks.applyPageOrder.mock.calls as unknown as [unknown, string, PagePlacement[]][])[0]?.[2] ?? [];
const operationRow: { claim: number; classifier: Record<string, unknown> } = { claim: 1, classifier: {} };
type LiveRow = { id: string; index: number; chapterId?: string | null };
type TransactionBook = {
  live?: readonly LiveRow[];
  removed?: readonly Record<string, unknown>[];
  chapters?: readonly { id: string; index: number; targetPages: number }[];
};

const transaction = (book: TransactionBook = {}) => {
  const live = book.live ?? pagesBefore;
  const removed = book.removed ?? [];
  const chapters = book.chapters ?? [{ id: "chapter-1", index: 1, targetPages: 4 }];
  return {
  bookEditOperation: {
    updateMany: vi.fn(async () => {
      mocks.order.push("bookEditOperation.updateMany");
      return { count: operationRow.claim };
    }),
    findUnique: vi.fn(async () => {
      mocks.order.push("bookEditOperation.findUnique");
      return { classifier: operationRow.classifier };
    }),
    update: mocks.track("bookEditOperation.update", {})
  },
  page: {
    createMany: mocks.track("page.createMany", {}),
    deleteMany: mocks.track("page.deleteMany", {}),
    updateMany: mocks.track("page.updateMany", {}),
    // Three different reads share this method, and which one it is decides what
    // the book answers with: the pages the shift is planned against, the removed
    // pages the undo record is built from, and the rows an insert just created.
    findMany: vi.fn(async (args: { include?: unknown; where?: { index?: unknown; id?: { in: string[] } } }) => {
      mocks.order.push("tx.page.findMany");
      if (args.include) {
        // Scoped the way the real read is, so an undo record built from a list
        // the reconciliation trimmed cannot claim a row nothing here took.
        return removed.filter((row) => args.where?.id?.in.includes(String(row.id)) ?? true);
      }
      if (args.where?.index !== undefined) {
        return [{ id: "new-1" }, { id: "new-2" }];
      }
      return live.map((row) => ({ ...row }));
    })
  },
  pageEditSnapshot: { findMany: mocks.track("pageEditSnapshot.findMany", []) },
  chapter: { update: mocks.track("chapter.update", {}), findMany: mocks.track("tx.chapter.findMany", chapters) },
  planVersion: {
    update: mocks.track("planVersion.update", {}),
    create: mocks.track("planVersion.create", { id: "plan-4" })
  },
  project: {
    findUnique: mocks.track("project.findUnique", { pdfPageMap: null }),
    update: mocks.track("project.update", {})
  }
  };
};

const apply = async (
  structural: StructuralPagePlan,
  removed: Record<string, unknown>[] = [],
  book: {
    plan?: BookPlan;
    chapters?: { id: string; index: number; targetPages: number }[];
    /** What the transaction's own read answers, when it is not the four-page book. */
    live?: readonly LiveRow[];
  } = {}
) => {
  const tx = transaction({
    removed,
    ...(book.live ? { live: book.live } : {}),
    ...(book.chapters ? { chapters: book.chapters } : {})
  });
  mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
  const result = await applyStructuralPageChange({
    projectId: "project-1",
    operationId: "op-1",
    request: "delete page 2",
    plan: structural,
    bookPlan: book.plan ?? bookPlan([4]),
    input: {} as CreateProjectInput,
    basePlanVersionId: "plan-3",
    previousTargetPages: 4,
    ownerToken: "delivery-a"
  });
  return { tx, result };
};

/** The application off a result that is supposed to carry one. */
const appliedBy = (result: Awaited<ReturnType<typeof apply>>["result"]): StructuralApplication => {
  if (
    result.outcome === "settled" ||
    result.outcome === "stale" ||
    result.outcome === "completed" ||
    !result.application
  ) {
    throw new Error(`the structural change ${result.outcome} instead of applying`);
  }
  return result.application;
};

beforeEach(() => {
  mocks.leaseClaim = {
    outcome: "acquired",
    phase: "draft",
    application: null,
    expiresAt: new Date("2026-08-17T00:03:00.000Z")
  };
});

describe("applying a structural page change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    operationRow.claim = 1;
    operationRow.classifier = {};
    mocks.leaseClaim = {
      outcome: "acquired",
      phase: "draft",
      application: null,
      expiresAt: new Date("2026-08-17T00:03:00.000Z")
    };
  });

  it("takes the deleted pages' semantic memory in the same transaction that deletes them", async () => {
    const { tx } = await apply(
      plan({
        removedPageIds: ["page-2"],
        order: [
          { pageId: "page-1", index: 1 },
          { pageId: "page-3", index: 2 },
          { pageId: "page-4", index: 3 }
        ],
        totalPages: 3
      }),
      [{ id: "page-2", index: 2, chapterId: "chapter-1", title: "Two", markdown: "", summary: "", images: [] }]
    );

    // `Embedding` cascades on `Project`, not on `Page`, and `sourceId` is a
    // plain string — so nothing else ever takes these rows. Left behind, the
    // deleted page's `page:2` summary would be the memory the reorder below
    // hands to the page moving up into index 2, and the retrieval dedupes by
    // scope: a live page's own summary can lose to a deleted page's.
    expect(mocks.deletePageEmbeddings).toHaveBeenCalledWith(tx, "project-1", ["page-2"]);
    expect(mocks.deletePageContinuityNotes).toHaveBeenCalledWith(tx, "project-1", ["page-2"]);
    // Before the reorder re-points the survivors onto those very indexes.
    expect(mocks.order.indexOf("deletePageEmbeddings")).toBeLessThan(mocks.order.indexOf("repointPageEmbeddings"));
    expect(mocks.order.indexOf("deletePageEmbeddings")).toBeLessThan(mocks.order.indexOf("applyPageOrder"));
  });

  it("touches no embedding rows when a reorder deletes nothing", async () => {
    const { tx } = await apply(
      plan({
        action: "move",
        order: [
          { pageId: "page-2", index: 1 },
          { pageId: "page-1", index: 2 },
          { pageId: "page-3", index: 3 },
          { pageId: "page-4", index: 4 }
        ]
      })
    );

    expect(mocks.deletePageEmbeddings).not.toHaveBeenCalled();
    expect(mocks.repointPageEmbeddings).toHaveBeenCalled();
    expect(mocks.discardLegacyPageContinuityNotes).toHaveBeenCalledWith(tx, "project-1");
    expect(mocks.repointPageContinuityNotes).toHaveBeenCalled();
    expect(mocks.deletePageContinuityNotes).not.toHaveBeenCalled();
  });

  it("re-points the tail an insert pushed down, which no ordering names", async () => {
    await apply(plan({ action: "insert", insertAfterIndex: 2, newPageIndexes: [3, 4], totalPages: 6 }));

    // An insert opens its gap with a shift instead of an ordering, so the pages
    // that moved are derived from the ones that existed before.
    expect(mocks.repointPageEmbeddings).toHaveBeenCalledWith(expect.anything(), "project-1", [
      { pageId: "page-3", index: 5 },
      { pageId: "page-4", index: 6 }
    ]);
    expect(mocks.deletePageEmbeddings).not.toHaveBeenCalled();
  });

  it("stamps the operation last, after the shift it fences", async () => {
    const { result } = await apply(
      plan({ action: "insert", insertAfterIndex: 4, newPageIndexes: [5, 6], totalPages: 6 })
    );

    expect(result.outcome).toBe("applied");
    expect(appliedBy(result).newPlanVersionId).toBe("plan-4");
    expect(appliedBy(result).insertedPageIds).toEqual(["new-1", "new-2"]);
    expect(mocks.order.at(-1)).toBe("bookEditOperation.update");
  });

  it("locks Project before the operation lease and every structural write", async () => {
    const { tx } = await apply(plan({ action: "insert", insertAfterIndex: 4, newPageIndexes: [5, 6], totalPages: 6 }));
    expect(mocks.order[0]).toBe("project.update");
    expect(mocks.order[1]).toBe("bookEditOperation.updateMany");
    expect(mocks.order[2]).toBe("bookEditOperation.findUnique");
    expect(tx.project.update).toHaveBeenNthCalledWith(1, { where: { id: "project-1" }, data: { contentRevision: { increment: 0 } } });
    expect(mocks.order.indexOf("bookEditOperation.findUnique")).toBeLessThan(
      mocks.order.indexOf("shiftPageIndexes")
    );
  });

  it("shifts nothing when a concurrent delivery committed the stamp first", async () => {
    operationRow.classifier = {
      structuralApplication: {
        action: "insert",
        pageOrderBefore: pagesBefore.map((page) => ({ pageId: page.id, index: page.index })),
        insertedPageIds: ["new-1", "new-2"],
        removedPages: [],
        basePlanVersionId: "plan-3",
        newPlanVersionId: "plan-4",
        previousTargetPages: 4,
        previousChapterTargetPages: {},
        appliedAt: "2026-08-17T00:00:00.000Z"
      }
    };
    mocks.leaseClaim = {
      outcome: "busy",
      application: operationRow.classifier.structuralApplication,
      retryAt: new Date("2026-08-17T00:03:00.000Z")
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { tx, result } = await apply(
      plan({ action: "insert", insertAfterIndex: 4, newPageIndexes: [5, 6], totalPages: 6 })
    );

    expect(result.outcome).toBe("already-applied");
    expect(mocks.shiftPageIndexes).not.toHaveBeenCalled();
    expect(mocks.applyPageOrder).not.toHaveBeenCalled();
    expect(mocks.repointPageEmbeddings).not.toHaveBeenCalled();
    expect(tx.page.createMany).not.toHaveBeenCalled();
    expect(tx.planVersion.create).not.toHaveBeenCalled();
    expect(tx.project.update).toHaveBeenCalledTimes(1);
    expect(tx.bookEditOperation.update).not.toHaveBeenCalled();
    expect(appliedBy(result).insertedPageIds).toEqual(["new-1", "new-2"]);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "generation.structural_delivery_lost_claim" })
    );
    warn.mockRestore();
  });

  it("shifts nothing when the operation was settled while this delivery prepared", async () => {
    operationRow.claim = 0;
    mocks.leaseClaim = { outcome: "settled" };

    const { tx, result } = await apply(
      plan({ action: "insert", insertAfterIndex: 4, newPageIndexes: [5, 6], totalPages: 6 })
    );

    expect(result.outcome).toBe("settled");
    expect(mocks.shiftPageIndexes).not.toHaveBeenCalled();
    expect(tx.planVersion.create).not.toHaveBeenCalled();
    expect(tx.bookEditOperation.findUnique).not.toHaveBeenCalled();
  });
});

describe("holding the plan to the book the claim actually finds", () => {
  let warn: MockInstance;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    operationRow.claim = 1;
    operationRow.classifier = {};
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  /** The four-page book minus page 3, renumbered by whoever took it. */
  const withoutPageThree: LiveRow[] = [
    { id: "page-1", index: 1, chapterId: "chapter-1" },
    { id: "page-2", index: 2, chapterId: "chapter-1" },
    { id: "page-4", index: 3, chapterId: "chapter-1" }
  ];

  it("drops a placement naming a page that left, and renumbers the book over the gap", async () => {
    const { tx, result } = await apply(
      plan({
        action: "move",
        order: [
          { pageId: "page-2", index: 1 },
          { pageId: "page-3", index: 2 },
          { pageId: "page-4", index: 3 },
          { pageId: "page-1", index: 4 }
        ]
      }),
      [],
      { live: withoutPageThree }
    );

    expect(result.outcome).toBe("applied");
    expect(writtenPageOrder()).toEqual([
      { pageId: "page-2", index: 1 },
      { pageId: "page-4", index: 2 },
      { pageId: "page-1", index: 3 }
    ]);
    // The `page:<index>` memory scopes follow the pages to where they land, not
    // to where the stale plan said they would.
    expect(mocks.repointPageEmbeddings).toHaveBeenCalledWith(expect.anything(), "project-1", [
      { pageId: "page-2", index: 1 },
      { pageId: "page-4", index: 2 },
      { pageId: "page-1", index: 3 }
    ]);
    // The book's new length reaches the snapshot `inputForPlanVersion` reads: a
    // plan version claiming four pages beside a three-page manuscript is the
    // `PAGE_COUNT_MISMATCH` that refuses the compile.
    expect(createdPlanVersion(tx).data.inputSnapshot.targetPages).toBe(3);
    // The undo record describes the book this transaction found, never the one
    // the card described — undo replays it against the rows that exist.
    expect(appliedBy(result).pageOrderBefore).toEqual([
      { pageId: "page-1", index: 1, chapterId: "chapter-1" },
      { pageId: "page-2", index: 2, chapterId: "chapter-1" },
      { pageId: "page-4", index: 3, chapterId: "chapter-1" }
    ]);
    // Never silent: the shift landed on a book the card did not quite describe.
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "generation.structural_plan_reconciled", plannedPages: 4, totalPages: 3 })
    );
  });

  it("puts a page that arrived under the plan at the tail rather than leaving it unnamed", async () => {
    // The other direction: a continuation appended page 5 while this delete was
    // being prepared. Leaving it out of the ordering is the same hole from the
    // other side — it keeps index 5 while the survivors renumber into 1..3.
    const { tx } = await apply(
      plan({
        removedPageIds: ["page-2"],
        order: [
          { pageId: "page-1", index: 1, chapterId: "chapter-1" },
          { pageId: "page-3", index: 2, chapterId: "chapter-1" },
          { pageId: "page-4", index: 3, chapterId: "chapter-1" }
        ],
        totalPages: 3
      }),
      [{ id: "page-2", index: 2, chapterId: "chapter-1", title: "Two", markdown: "", summary: "", images: [] }],
      {
        live: [
          { id: "page-1", index: 1, chapterId: "chapter-1" },
          { id: "page-2", index: 2, chapterId: "chapter-1" },
          { id: "page-3", index: 3, chapterId: "chapter-1" },
          { id: "page-4", index: 4, chapterId: "chapter-1" },
          { id: "page-5", index: 5, chapterId: "chapter-1" }
        ]
      }
    );

    // Appended, because appending is how a page arrives on a finished book — and
    // it is the answer `restoredPageOrder` already gives on the undo side. Two
    // different answers to "where does a page nobody named belong" is how the
    // two ends of the queue start disagreeing about one row.
    expect(writtenPageOrder().map((placement) => ({ pageId: placement.pageId, index: placement.index }))).toEqual([
      { pageId: "page-1", index: 1 },
      { pageId: "page-3", index: 2 },
      { pageId: "page-4", index: 3 },
      { pageId: "page-5", index: 4 }
    ]);
    // A page nobody named is not a page anybody re-homes: it keeps the chapter
    // it already holds, so the grouped write has nothing to say about it.
    expect(tx.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.deletePageEmbeddings).toHaveBeenCalledWith(tx, "project-1", ["page-2"]);
    expect(createdPlanVersion(tx).data.inputSnapshot.targetPages).toBe(4);
  });

  it("re-clamps an insert whose anchor outran a book that shrank", async () => {
    // An insert names no ordering, so the anchor is its one exposed half. The
    // resolver clamps one past the end because "add two pages at the end" is a
    // real request; a book that lost a page leaves that clamp past the *new* end,
    // and the shift then moves nothing while `createMany` writes at indexes no
    // survivor reaches — a book numbered 1, 2, 3, 5, 6.
    const { tx } = await apply(
      plan({
        action: "insert",
        insertAfterIndex: 4,
        newPageIndexes: [5, 6],
        newPageChapterId: "chapter-1",
        totalPages: 6
      }),
      [],
      { live: withoutPageThree }
    );

    expect(mocks.shiftPageIndexes).toHaveBeenCalledWith(expect.anything(), "project-1", { afterIndex: 3, delta: 2 });
    expect(tx.page.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ index: 4, chapterId: "chapter-1" }),
        expect.objectContaining({ index: 5, chapterId: "chapter-1" })
      ]
    });
    expect(createdPlanVersion(tx).data.inputSnapshot.targetPages).toBe(5);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "generation.structural_plan_reconciled", action: "insert" })
    );
  });

  it("takes the pages a delete can still reach and leaves the one it cannot", async () => {
    // A page somebody else already deleted is a delete that is partly done, not
    // one that failed. `deleteMany` would tolerate the dead id, but the undo
    // record read alongside it would not: a removed-page record for a row this
    // transaction never took puts back a page somebody else deliberately removed.
    const { tx, result } = await apply(
      plan({
        removedPageIds: ["page-3", "page-4"],
        order: [
          { pageId: "page-1", index: 1 },
          { pageId: "page-2", index: 2 }
        ],
        totalPages: 2
      }),
      [{ id: "page-4", index: 3, chapterId: "chapter-1", title: "Four", markdown: "", summary: "", images: [] }],
      { live: withoutPageThree }
    );

    expect(result.outcome).toBe("applied");
    expect(tx.page.deleteMany).toHaveBeenCalledWith({ where: { projectId: "project-1", id: { in: ["page-4"] } } });
    expect(mocks.deletePageEmbeddings).toHaveBeenCalledWith(tx, "project-1", ["page-4"]);
    expect(appliedBy(result).removedPages.map((page) => page.id)).toEqual(["page-4"]);
    expect(writtenPageOrder()).toEqual([
      { pageId: "page-1", index: 1 },
      { pageId: "page-2", index: 2 }
    ]);
  });

  it("stands down without writing when the pages a delete named have all gone", async () => {
    // The abort half. Nothing is left of what this edit asked for, so it settles
    // exactly as a resolver refusal does — free, marked, charge handed back —
    // rather than bumping the revision and recompiling an unchanged book.
    const { tx, result } = await apply(
      plan({
        removedPageIds: ["page-3"],
        order: [
          { pageId: "page-1", index: 1 },
          { pageId: "page-2", index: 2 },
          { pageId: "page-4", index: 3 }
        ],
        totalPages: 3
      }),
      [],
      { live: withoutPageThree }
    );

    expect(result).toEqual({ outcome: "stale", reason: "nothing_to_do" });
    // The claim ran and commits, and that is *all* that commits: no shift, no
    // plan version, no stamp — a stamp would tell a redelivery the shift landed.
    expect(mocks.acquireStructuralPageLeaseTx).toHaveBeenCalledTimes(1);
    expect(mocks.applyPageOrder).not.toHaveBeenCalled();
    expect(mocks.deletePageEmbeddings).not.toHaveBeenCalled();
    expect(tx.page.deleteMany).not.toHaveBeenCalled();
    expect(tx.planVersion.create).not.toHaveBeenCalled();
    expect(tx.project.update).toHaveBeenCalledTimes(1);
    expect(tx.bookEditOperation.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "generation.structural_plan_stale", reason: "nothing_to_do" })
    );
  });
});

describe("re-homing the pages an edit moves between chapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    operationRow.claim = 1;
    operationRow.classifier = {};
  });

  type Row = { id: string; index: number; chapterId: string | null };

  /** A realistic long book: 120 pages cut into eight chapters of fifteen. */
  const longBook = (): Row[] =>
    Array.from({ length: 120 }, (_value, offset) => ({
      id: `page-${offset + 1}`,
      index: offset + 1,
      chapterId: `chapter-${Math.floor(offset / 15) + 1}`
    }));
  const longBookChapters = Array.from({ length: 8 }, (_value, offset) => ({
    id: `chapter-${offset + 1}`,
    index: offset + 1,
    targetPages: 15
  }));

  type RehomeArgs = {
    where: { id: { in: string[] }; projectId: string };
    data: { chapterId: string | null };
  };

  /**
   * The transaction, with a `page.updateMany` that answers the way Postgres
   * does: every row the statement names takes the chapter it carries.
   */
  const rehomingTransaction = (rows: Row[]) => {
    // `live: rows` and not a copy: the fixture's own read snapshots it, so the
    // pages the transaction plans against are the ones it is about to move.
    const base = transaction({ live: rows, chapters: longBookChapters });
    const rehomes: RehomeArgs[] = [];
    return {
      ...base,
      rehomes,
      page: {
        ...base.page,
        updateMany: vi.fn(async (args: RehomeArgs) => {
          rehomes.push(args);
          const named = new Set(args.where.id.in);
          let count = 0;
          for (const row of rows) {
            if (named.has(row.id)) {
              row.chapterId = args.data.chapterId;
              count += 1;
            }
          }
          return { count };
        })
      }
    };
  };

  /** The assignment the per-placement loop this replaced would have written. */
  const rehomedOnePlacementAtATime = (
    rows: readonly Row[],
    order: readonly PagePlacement[]
  ): Map<string, string | null> => {
    const assignment = new Map(rows.map((row) => [row.id, row.chapterId]));
    for (const placement of order) {
      if (placement.chapterId === undefined) {
        continue;
      }
      const held = assignment.get(placement.pageId);
      // `id: <pageId>` matched no row, or the row already sat where the
      // placement puts it and the grouping never named it.
      if (held !== undefined && held !== placement.chapterId) {
        assignment.set(placement.pageId, placement.chapterId);
      }
    }
    return assignment;
  };

  const applyToBook = async (rows: Row[], structural: StructuralPagePlan) => {
    const tx = rehomingTransaction(rows);
    mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    const result = await applyStructuralPageChange({
      projectId: "project-1",
      operationId: "op-1",
      request: "restructure",
      plan: structural,
      bookPlan: bookPlan(longBookChapters.map((chapter) => chapter.targetPages)),
      input: {} as CreateProjectInput,
      basePlanVersionId: "plan-3",
      previousTargetPages: 120,
      ownerToken: "delivery-a"
    });
    return Object.assign(tx, { result });
  };

  const chapterOf = (rows: readonly Row[]): Map<string, string | null> =>
    new Map(rows.map((row) => [row.id, row.chapterId]));

  const requests: { name: string; edit: StructuralPageEdit }[] = [
    { name: "an insert in the middle", edit: { action: "insert", anchorPageIndex: 40, pageIndexes: [], pageCount: 3 } },
    {
      name: "a delete spanning two chapters",
      edit: { action: "delete", anchorPageIndex: null, pageIndexes: [29, 30, 31, 32], pageCount: 0 }
    },
    {
      name: "a move inside one chapter",
      edit: { action: "move", anchorPageIndex: 10, pageIndexes: [3, 4], pageCount: 0 }
    },
    {
      name: "a move across chapters",
      edit: { action: "move", anchorPageIndex: 100, pageIndexes: [7, 8, 9], pageCount: 0 }
    },
    {
      name: "a move of a selection spanning three chapters",
      edit: { action: "move", anchorPageIndex: 60, pageIndexes: [14, 15, 16, 31], pageCount: 0 }
    },
    {
      name: "a move to the head of the book",
      edit: { action: "move", anchorPageIndex: 0, pageIndexes: [80, 81], pageCount: 0 }
    }
  ];

  // The grouped write has to leave every page in the chapter the statement-per-
  // placement loop would have left it in — not merely for the pages the request
  // named. `resolveStructuralPageEdit` is the real resolver, so these are the
  // orderings the book actually gets.
  it.each(requests)("leaves $name assigning chapters exactly as the per-page loop did", async ({ edit }) => {
    const rows = longBook();
    const before = rows.map((row) => ({ ...row }));
    const resolved = resolveStructuralPageEdit(edit, before);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }

    await applyToBook(rows, resolved.plan);

    expect(chapterOf(rows)).toEqual(rehomedOnePlacementAtATime(before, resolved.plan.order));
  });

  it("writes nothing at all for a delete, which cannot move a page between chapters", async () => {
    const rows = longBook();
    const resolved = resolveStructuralPageEdit(
      { action: "delete", anchorPageIndex: null, pageIndexes: [29, 30, 31, 32], pageCount: 0 },
      rows.map((row) => ({ ...row }))
    );
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }

    const tx = await applyToBook(rows, resolved.plan);

    // A chapter is stored only as `Page.chapterId`, never as a range of indexes,
    // so renumbering the survivors moves none of them. This was 116 round trips
    // — one per surviving page — inside a transaction with a 30 s ceiling.
    expect(resolved.plan.order).toHaveLength(116);
    expect(tx.rehomes).toEqual([]);
  });

  it("re-homes a move in one statement naming only the pages that moved", async () => {
    const rows = longBook();
    const resolved = resolveStructuralPageEdit(
      { action: "move", anchorPageIndex: 100, pageIndexes: [7, 8, 9], pageCount: 0 },
      rows.map((row) => ({ ...row }))
    );
    if (!resolved.ok) throw new Error(resolved.reason);
    const tx = await applyToBook(rows, resolved.plan);

    expect(tx.rehomes).toEqual([
      {
        where: { id: { in: ["page-7", "page-8", "page-9"] }, projectId: "project-1" },
        data: { chapterId: "chapter-7" }
      }
    ]);
    expect(appliedBy(tx.result).pageOrderBefore.slice(6, 9)).toEqual([
      { pageId: "page-7", index: 7, chapterId: "chapter-1" },
      { pageId: "page-8", index: 8, chapterId: "chapter-1" },
      { pageId: "page-9", index: 9, chapterId: "chapter-1" }
    ]);
  });

  it("names only the pages the book still holds when one left under the plan", async () => {
    const rows = longBook();
    const resolved = resolveStructuralPageEdit(
      { action: "move", anchorPageIndex: 100, pageIndexes: [7, 8, 9], pageCount: 0 },
      rows.map((row) => ({ ...row }))
    );
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Page 61 left between the resolver's read and the claim, so the ordering
    // names 120 pages and the transaction finds 119.
    const gone = rows.splice(60, 1)[0]!;

    const tx = await applyToBook(rows, resolved.plan);

    // The re-home is the one it always was. `pagesToRehome` never sees the
    // placement this snapshot cannot account for — the reconciliation drops it
    // first — so the one statement left names the pages that moved and nothing
    // else, and a page the book no longer holds simply matches no row.
    expect(tx.rehomes).toEqual([
      {
        where: { id: { in: ["page-7", "page-8", "page-9"] }, projectId: "project-1" },
        data: { chapterId: "chapter-7" }
      }
    ]);
    // Renumbered over the gap, so the book still runs 1..N with no placement
    // claiming an index no row can take.
    const written = writtenPageOrder();
    expect(written.some((placement) => placement.pageId === gone.id)).toBe(false);
    expect(written.map((placement) => placement.index)).toEqual(rows.map((_row, offset) => offset + 1));
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "generation.structural_plan_reconciled", totalPages: 119 })
    );
    warn.mockRestore();
  });
});

describe("keeping the stored plan's chapter targets with the snapshot beside them", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    operationRow.claim = 1;
    operationRow.classifier = {};
  });

  const deleteOnePage = (overrides: Partial<StructuralPagePlan> = {}) =>
    plan({
      removedPageIds: ["page-2"],
      order: [
        { pageId: "page-1", index: 1 },
        { pageId: "page-3", index: 2 },
        { pageId: "page-4", index: 3 }
      ],
      totalPages: 3,
      ...overrides
    });

  it("writes the measured counts through untouched when they explain the whole book", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tx } = await apply(deleteOnePage({ chapterPageCounts: { "chapter-1": 2, "chapter-2": 1 } }), [], {
      plan: bookPlan([2, 2]),
      chapters: [
        { id: "chapter-1", index: 1, targetPages: 2 },
        { id: "chapter-2", index: 2, targetPages: 2 }
      ]
    });

    // Nothing is re-partitioned and nothing is reported: the pages themselves
    // said where every chapter now begins.
    expect(chapterTargetsOf(tx)).toEqual([2, 1]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("brings the targets down to the new length when no chapter measured a page count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // `chapterPageCounts` is keyed on `Page.chapterId`, so a book whose pages
    // all carry a null one measures nothing — and `Page.chapter` is
    // `onDelete: SetNull`, so the rows can still be there. This used to return
    // the plan exactly as it came in, next to an `inputSnapshot` that had
    // already recorded the book's new length: two halves of one plan version
    // disagreeing about how long the book is, which puts the last chapter
    // heading on a page the book no longer has.
    const { tx } = await apply(deleteOnePage({ chapterPageCounts: {} }), [], {
      plan: bookPlan([2, 2]),
      chapters: [
        { id: "chapter-1", index: 1, targetPages: 2 },
        { id: "chapter-2", index: 2, targetPages: 2 }
      ]
    });

    // The tail chapter absorbs the loss, so chapter 2 still opens on page 3 —
    // the reconciliation that re-chapters nothing the reader has already read.
    expect(chapterTargetsOf(tx)).toEqual([2, 1]);
    expect(chapterTargetsOf(tx).reduce((sum, target) => sum + target, 0)).toBe(3);
    expect(createdPlanVersion(tx).data.inputSnapshot.targetPages).toBe(3);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ warning: "structural_chapter_targets_unmeasured", projectId: "project-1" })
    );
    warn.mockRestore();
  });

  it("re-partitions when the tail chapter cannot absorb what the counts leave over", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A plan whose targets already over-counted the book: absorbing bottoms out
    // at one page, so the tail cannot take the rest and the whole plan is
    // re-fitted rather than left summing to a length nothing else agrees with.
    const { tx } = await apply(deleteOnePage({ chapterPageCounts: {} }), [], {
      plan: bookPlan([2, 2, 6]),
      chapters: []
    });

    expect(chapterTargetsOf(tx)).toEqual([1, 1, 1]);
    expect(createdPlanVersion(tx).data.inputSnapshot.targetPages).toBe(3);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ warning: "structural_chapter_targets_repartitioned", totalPages: 3 })
    );
    warn.mockRestore();
  });
});
