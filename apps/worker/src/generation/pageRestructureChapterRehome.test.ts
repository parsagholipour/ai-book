import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: { $transaction: vi.fn() },
  acquireStructuralPageLeaseTx: vi.fn(async () => ({
    outcome: "acquired",
    phase: "draft",
    application: null,
    expiresAt: new Date("2026-08-17T00:03:00.000Z")
  }))
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  applyPageOrder: vi.fn(),
  shiftPageIndexes: vi.fn(),
  repointPageContinuityNotes: vi.fn(),
  repointPageEmbeddings: vi.fn(),
  deletePageContinuityNotes: vi.fn(),
  deletePageEmbeddings: vi.fn(),
  discardLegacyPageContinuityNotes: vi.fn(),
  repointedPageMapUpdate: () => ({})
}));
vi.mock("./bookHelpers.js", () => ({
  nextPlanVersion: async () => 4,
  planInputSnapshot: (input: unknown) => input
}));
vi.mock("./structuralPageLease.js", () => ({
  acquireStructuralPageLeaseTx: mocks.acquireStructuralPageLeaseTx
}));

import { bookPlanSchema, resolveStructuralPageEdit, type CreateProjectInput } from "@book-maker/core";
import { applyStructuralPageChange } from "./pageRestructure.js";

type Row = { id: string; index: number; chapterId: string | null };
type RehomeArgs = {
  where: { id: { in: string[] }; projectId: string; chapterId?: { not: string | null } };
  data: { chapterId: string | null };
};

/**
 * A six-page book whose last page belongs to no chapter.
 *
 * That is an ordinary shape, not a contrived one: `Page.chapter` is
 * `onDelete: SetNull`, and the whole-book save paths (`bookPasses.ts`,
 * `checkpointWholeBookDraftPages`) store a page that falls outside every
 * chapter's page range with a null `chapterId`.
 */
const book = (): Row[] => [
  { id: "page-1", index: 1, chapterId: "chapter-1" },
  { id: "page-2", index: 2, chapterId: "chapter-1" },
  { id: "page-3", index: 3, chapterId: "chapter-2" },
  { id: "page-4", index: 4, chapterId: "chapter-2" },
  { id: "page-5", index: 5, chapterId: "chapter-2" },
  { id: "page-6", index: 6, chapterId: null }
];
const chapters = [
  { id: "chapter-1", index: 1, targetPages: 2 },
  { id: "chapter-2", index: 2, targetPages: 3 }
];
const bookPlan = bookPlanSchema.parse({
  title: "Book",
  premise: "Premise",
  audience: "Everyone",
  writingComplexity: 5,
  voiceGuide: ["Warm"],
  antiAiRules: ["No filler"],
  chapters: chapters.map((chapter) => ({
    index: chapter.index,
    title: `Chapter ${chapter.index}`,
    summary: "Summary",
    targetPages: chapter.targetPages
  })),
  illustrationPlan: { globalStyle: "Ink" }
});

/**
 * The transaction, with a `page.updateMany` that answers the way Postgres does
 * — including for a `chapterId: { not: … }` this write must not send: Prisma
 * compiles it to a bare `"chapterId" <> $1`, and `<>` against a null column is
 * UNKNOWN, so a guarded statement silently skips every page in no chapter.
 */
const transaction = (rows: Row[]) => {
  const writes: RehomeArgs[] = [];
  const track = <T>(value: T) => vi.fn(async () => value);
  return {
    writes,
    bookEditOperation: { findUnique: track({ classifier: {} }), update: track({}) },
    page: {
      findMany: vi.fn(async () => rows.map((row) => ({ ...row }))),
      deleteMany: track({ count: 0 }),
      updateMany: vi.fn(async (args: RehomeArgs) => {
        writes.push(args);
        const named = new Set(args.where.id.in);
        let count = 0;
        for (const row of rows) {
          const guard = args.where.chapterId;
          if (!named.has(row.id) || (guard && (row.chapterId === null || row.chapterId === guard.not))) {
            continue;
          }
          row.chapterId = args.data.chapterId;
          count += 1;
        }
        return { count };
      })
    },
    pageEditSnapshot: { findMany: track([]) },
    chapter: { findMany: track(chapters), update: track({}) },
    planVersion: { update: track({}), create: track({ id: "plan-4" }) },
    project: { findUnique: track({ pdfPageMap: null }), update: track({}) }
  };
};

describe("re-homing a page that belongs to no chapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves it into the destination chapter rather than leaving it chapterless inside one", async () => {
    const rows = book();
    // "Move page 6 to after page 3" — into the middle of chapter 2.
    const resolved = resolveStructuralPageEdit(
      { action: "move", anchorPageIndex: 3, pageIndexes: [6], pageCount: 0 },
      rows.map((row) => ({ ...row }))
    );
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    const tx = transaction(rows);
    mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));

    const result = await applyStructuralPageChange({
      projectId: "project-1",
      operationId: "op-1",
      request: "move page 6 after page 3",
      plan: resolved.plan,
      bookPlan,
      input: {} as CreateProjectInput,
      basePlanVersionId: "plan-3",
      previousTargetPages: 6,
      ownerToken: "delivery-a"
    });

    expect(result.outcome).toBe("applied");
    // The page the reader moved now belongs to the chapter it prints inside.
    // Guarded, this row was the one the statement could not see, so the book
    // printed it under chapter 2's heading while `chapterPageCounts` — which
    // counts only truthy ids — described a chapter one page shorter.
    expect(rows.find((row) => row.id === "page-6")?.chapterId).toBe("chapter-2");
    // One statement, naming only the page that moved: the grouping already
    // drops every page sitting in its destination, so the write needs no
    // chapter predicate of its own — and must not carry one.
    expect(tx.writes).toEqual([
      { where: { id: { in: ["page-6"] }, projectId: "project-1" }, data: { chapterId: "chapter-2" } }
    ]);
  });
});
