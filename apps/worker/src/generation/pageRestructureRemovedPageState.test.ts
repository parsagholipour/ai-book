import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The other half of "a deleted page comes back as it was": the stamp has to
 * hold the page's state in the first place. `PageEditSnapshot` cascades on
 * `Page`, so this record is the *only* copy of a removed page, and a field it
 * leaves out is a field the reader loses on a tap that promised to put the page
 * back. See `packages/db/src/pageRestructureRevertPageState.test.ts` for the
 * restore side.
 */

const mocks = vi.hoisted(() => ({
  prisma: { $transaction: vi.fn() },
  acquireStructuralPageLeaseTx: vi.fn(async () => ({
    outcome: "acquired",
    phase: "draft",
    application: null,
    expiresAt: new Date("2026-08-19T00:03:00.000Z")
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

import { bookPlanSchema, type StructuralPagePlan } from "@book-maker/core";
import { applyStructuralPageChange } from "./pageRestructure.js";

const pages = [1, 2, 3].map((index) => ({ id: `page-${index}`, index, chapterId: "chapter-1" }));

/** The removed page as the transaction's own read answers it. */
const removedPage = (overrides: Record<string, unknown>) => ({
  ...pages[1],
  title: "Two",
  markdown: "Body",
  summary: "Summary",
  imagePrompt: "An ink drawing of a lighthouse.",
  revision: 2,
  storyDelta: null,
  status: "COMPLETED",
  qualityReport: null,
  imageFailureReason: null,
  images: [],
  ...overrides
});

const applyDelete = async (removed: Record<string, unknown>) => {
  const tx = transaction(removed);
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
  if (result.outcome !== "applied" || !result.application) {
    throw new Error(`the structural change ${result.outcome} instead of applying`);
  }
  const [record] = result.application.removedPages;
  if (!record) {
    throw new Error("the stamp recorded no removed page");
  }
  return record;
};

describe("the removed-page undo record", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carries the refused page's verdict and its report", async () => {
    const qualityReport = { approved: false, issues: ["The scene repeats page 1."] };

    const record = await applyDelete(removedPage({ status: "FAILED_QA", qualityReport }));

    expect(record).toMatchObject({ id: "page-2", status: "FAILED_QA", qualityReport });
  });

  it("carries the image-failure marker the free-tier quota counts", async () => {
    const record = await applyDelete(removedPage({ imageFailureReason: "every provider refused the prompt" }));

    expect(record).toMatchObject({ status: "COMPLETED", imageFailureReason: "every provider refused the prompt" });
  });

  it("omits a report and a failure reason the page never had", async () => {
    const record = await applyDelete(removedPage({}));

    // Written as absent rather than null, so the restore takes the column
    // defaults instead of writing an explicit JSON null into `qualityReport`.
    expect(record).not.toHaveProperty("qualityReport");
    expect(record).not.toHaveProperty("imageFailureReason");
    expect(record.status).toBe("COMPLETED");
  });
});

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

function transaction(removed: Record<string, unknown>) {
  const track = <T>(value: T) => vi.fn(async () => value);
  return {
    bookEditOperation: { findUnique: track({ classifier: {} }), update: track({}) },
    page: {
      findMany: vi.fn(async (args: { include?: unknown }) => (args.include ? [removed] : pages)),
      deleteMany: track({ count: 1 }),
      updateMany: track({ count: 0 })
    },
    pageEditSnapshot: { findMany: track([]) },
    archivedPageEditSnapshot: { createMany: track({ count: 0 }) },
    chapter: { findMany: track([{ id: "chapter-1", index: 1, targetPages: 3 }]), update: track({}) },
    planVersion: { update: track({}), create: track({ id: "plan-4" }) },
    project: { findUnique: track({ pdfPageMap: null }), update: track({}) }
  };
}
