import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  prisma: { $transaction: vi.fn() },
  applyPageOrder: vi.fn(async () => mocks.order.push("applyPageOrder")),
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
  applyPageOrder: mocks.applyPageOrder,
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

import { bookPlanSchema, type StructuralPagePlan } from "@book-maker/core";
import { applyStructuralPageChange } from "./pageRestructure.js";

describe("structural delete snapshot archival", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
  });

  it("archives every original field before Page cascade and stamps the restore pointer", async () => {
    const createdAt = new Date("2026-08-16T12:00:00.000Z");
    const snapshot = {
      id: "snapshot-old",
      projectId: "project-1",
      pageId: "page-2",
      operationId: "operation-old",
      pageIndex: 2,
      titleBefore: "Before title",
      markdownBefore: "Before body",
      summaryBefore: "Before summary",
      revisionBefore: 4,
      storyDeltaBefore: { factsAdded: ["Before fact"] },
      titleAfter: "After title",
      markdownAfter: "After body",
      summaryAfter: "After summary",
      revisionAfter: 5,
      createdAt
    };
    const tx = transaction(snapshot);
    mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));

    const result = await applyStructuralPageChange({
      projectId: "project-1",
      operationId: "operation-delete",
      request: "delete page 2",
      plan: deletePageTwo,
      bookPlan,
      input: {} as never,
      basePlanVersionId: "plan-3",
      previousTargetPages: 3,
      ownerToken: "delivery-a"
    });

    expect(tx.archivedPageEditSnapshot.createMany).toHaveBeenCalledWith({
      data: [{ ...snapshot, archiveKey: "operation-delete" }],
      skipDuplicates: true
    });
    expect(mocks.order.indexOf("archive.createMany")).toBeLessThan(mocks.order.indexOf("page.deleteMany"));
    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.application.snapshotArchive).toEqual({ key: "operation-delete", snapshotCount: 1 });
    }
  });
});

const pages = [1, 2, 3].map((index) => ({ id: `page-${index}`, index, chapterId: "chapter-1" }));
const deletePageTwo: StructuralPagePlan = {
  action: "delete",
  insertAfterIndex: 0,
  newPageIndexes: [],
  removedPageIds: ["page-2"],
  order: [
    { pageId: "page-1", index: 1, chapterId: "chapter-1" },
    { pageId: "page-3", index: 2, chapterId: "chapter-1" }
  ],
  newPageChapterId: null,
  chapterPageCounts: { "chapter-1": 2 },
  totalPages: 2,
  pagesBilled: 0
};
const bookPlan = bookPlanSchema.parse({
  title: "Book",
  premise: "Premise",
  audience: "Everyone",
  writingComplexity: 5,
  voiceGuide: ["Warm"],
  antiAiRules: ["No filler"],
  chapters: [{ index: 1, title: "One", summary: "Summary", targetPages: 3 }],
  illustrationPlan: { globalStyle: "Ink" }
});

function transaction(snapshot: Record<string, unknown>) {
  const track = <T>(name: string, value: T) => vi.fn(async () => {
    mocks.order.push(name);
    return value;
  });
  return {
    bookEditOperation: {
      findUnique: track("operation.findUnique", { classifier: {} }),
      update: track("operation.update", {})
    },
    page: {
      findMany: vi.fn(async (args: { include?: unknown }) => {
        mocks.order.push("page.findMany");
        return args.include
          ? [{ ...pages[1], title: "Two", markdown: "Body", summary: "Summary", imagePrompt: null, revision: 2, storyDelta: null, images: [] }]
          : pages;
      }),
      deleteMany: track("page.deleteMany", { count: 1 }),
      updateMany: track("page.updateMany", { count: 0 })
    },
    pageEditSnapshot: { findMany: track("snapshot.findMany", [snapshot]) },
    archivedPageEditSnapshot: { createMany: track("archive.createMany", { count: 1 }) },
    chapter: {
      findMany: track("chapter.findMany", [{ id: "chapter-1", index: 1, targetPages: 3 }]),
      update: track("chapter.update", {})
    },
    planVersion: {
      update: track("plan.update", {}),
      create: track("plan.create", { id: "plan-4" })
    },
    project: {
      findUnique: track("project.findUnique", { pdfPageMap: null }),
      update: track("project.update", {})
    }
  };
}
