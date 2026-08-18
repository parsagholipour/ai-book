import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The plan version number the shift writes, and the race it used to lose.
 *
 * `PlanVersion` carries `@@unique([projectId, version])`, so the read that picks
 * the number and the `create` that takes it are one operation. The read used to
 * happen before the transaction opened — the whole shift sat between them — and
 * `apply-book-edit` has no retry budget, so a writer committing a plan version
 * in that window failed and refunded a delivered edit over a number.
 */
const mocks = vi.hoisted(() => ({
  order: [] as string[],
  prisma: { $transaction: vi.fn() },
  applyPageOrder: vi.fn(async () => {
    mocks.order.push("applyPageOrder");
  }),
  acquireStructuralPageLeaseTx: vi.fn(async (_tx: unknown, _operationId: string, _ownerToken: string) => ({
    outcome: "acquired",
    phase: "draft",
    application: null,
    expiresAt: new Date("2026-08-17T00:03:00.000Z")
  })),
  /** The versions the project already holds, as the derivation would find them. */
  versions: [1, 2, 3],
  nextPlanVersion: vi.fn(async (_projectId: string, _client?: unknown) => {
    mocks.order.push("nextPlanVersion");
    return Math.max(0, ...mocks.versions) + 1;
  })
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
  nextPlanVersion: mocks.nextPlanVersion,
  planInputSnapshot: (input: unknown) => input
}));
vi.mock("./structuralPageLease.js", () => ({
  acquireStructuralPageLeaseTx: mocks.acquireStructuralPageLeaseTx
}));

import { bookPlanSchema, type StructuralPagePlan } from "@book-maker/core";
import { applyStructuralPageChange } from "./pageRestructure.js";

describe("the plan version a structural shift writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.versions = [1, 2, 3];
  });

  it("derives the number under the claim, after the base version's own row lock", async () => {
    const tx = transaction();
    mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));

    const result = await applyStructuralPageChange(options);

    // Handed the transaction client, never the global one: the number and the
    // create that takes it have to be the same statement pair.
    expect(mocks.nextPlanVersion).toHaveBeenCalledWith("project-1", tx);
    // And after the base version was superseded, which is the row lock every
    // other writer that adds a version to a book blocks on first.
    expect(mocks.order.indexOf("plan.update")).toBeLessThan(mocks.order.indexOf("nextPlanVersion"));
    expect(mocks.order.indexOf("nextPlanVersion")).toBeLessThan(mocks.order.indexOf("plan.create"));
    expect(createdVersions(tx)).toEqual([4]);
    expect(result.outcome).toBe("applied");
  });

  it("replays the whole shift when another writer commits that number first", async () => {
    const tx = transaction();
    mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    tx.planVersion.create.mockImplementationOnce(async () => {
      mocks.order.push("plan.create");
      // The competitor's row is committed and visible from here on, which is
      // what makes the replay derive a different number rather than the same
      // one again.
      mocks.versions.push(4);
      throw planVersionConflict();
    });

    const result = await applyStructuralPageChange(options);

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2);
    // Nothing survives a rolled-back attempt, so the replay starts where the
    // first one did: the lease is re-taken under this delivery's own token.
    expect(mocks.acquireStructuralPageLeaseTx).toHaveBeenCalledTimes(2);
    expect(mocks.acquireStructuralPageLeaseTx.mock.calls[1]?.[2]).toBe("delivery-a");
    // Re-derived rather than replayed: 4 is gone, so the edit takes 5.
    expect(createdVersions(tx)).toEqual([4, 5]);
    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.application.newPlanVersionId).toBe("plan-5");
    }
  });

  it("gives up rather than looping when the number keeps being taken", async () => {
    const tx = transaction();
    mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    tx.planVersion.create.mockImplementation(async () => {
      mocks.order.push("plan.create");
      throw planVersionConflict();
    });

    await expect(applyStructuralPageChange(options)).rejects.toMatchObject({ code: "P2002" });
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("does not replay a unique conflict that is not the version number", async () => {
    const tx = transaction();
    mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    // `@@unique([projectId, index])` is `reconcileStructuralPagePlan`'s to
    // answer, and replaying the shift would only hide it.
    mocks.applyPageOrder.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { modelName: "Page", target: ["projectId", "index"] }
      });
    });

    await expect(applyStructuralPageChange(options)).rejects.toMatchObject({ code: "P2002" });
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

const planVersionConflict = () =>
  Object.assign(new Error("Unique constraint failed on the fields: (`projectId`,`version`)"), {
    code: "P2002",
    meta: { modelName: "PlanVersion", target: ["projectId", "version"] }
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
const options = {
  projectId: "project-1",
  operationId: "operation-delete",
  request: "delete page 2",
  plan: deletePageTwo,
  bookPlan,
  input: {} as never,
  basePlanVersionId: "plan-3",
  previousTargetPages: 3,
  ownerToken: "delivery-a"
};

/** The `version` of every plan version the transaction tried to write, in order. */
const createdVersions = (tx: ReturnType<typeof transaction>): number[] =>
  (tx.planVersion.create.mock.calls as unknown as { data: { version: number } }[][]).map(
    (call) => call[0]!.data.version
  );

function transaction() {
  const track = <T>(name: string, value: T) =>
    vi.fn(async () => {
      mocks.order.push(name);
      return value;
    });
  let created = 0;
  return {
    bookEditOperation: {
      findUnique: track("operation.findUnique", { classifier: {} }),
      update: track("operation.update", {})
    },
    page: {
      findMany: vi.fn(async (args: { include?: unknown }) => {
        mocks.order.push("page.findMany");
        return args.include
          ? [
              {
                ...pages[1],
                title: "Two",
                markdown: "Body",
                summary: "Summary",
                imagePrompt: null,
                revision: 2,
                storyDelta: null,
                images: []
              }
            ]
          : pages;
      }),
      deleteMany: track("page.deleteMany", { count: 1 }),
      updateMany: track("page.updateMany", { count: 0 })
    },
    pageEditSnapshot: { findMany: track("snapshot.findMany", []) },
    archivedPageEditSnapshot: { createMany: track("archive.createMany", { count: 0 }) },
    chapter: {
      findMany: track("chapter.findMany", [{ id: "chapter-1", index: 1, targetPages: 3 }]),
      update: track("chapter.update", {})
    },
    planVersion: {
      update: track("plan.update", {}),
      create: vi.fn(async (args: { data: { version: number } }) => {
        mocks.order.push("plan.create");
        created += 1;
        return { id: `plan-${args.data.version}`, version: args.data.version, sequence: created };
      })
    },
    project: {
      findUnique: track("project.findUnique", { pdfPageMap: null }),
      update: track("project.update", {})
    }
  };
}
