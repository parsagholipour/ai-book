import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    project: { update: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findMany: vi.fn(), findFirst: vi.fn() },
    chapter: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn()
  },
  tx: {
    page: { deleteMany: vi.fn(), createMany: vi.fn() },
    chapter: { deleteMany: vi.fn(), create: vi.fn() },
    embedding: { deleteMany: vi.fn() },
    project: { update: vi.fn() },
    planVersion: { update: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() }
  },
  getProjectOrThrow: vi.fn(),
  invalidateProjectExports: vi.fn(),
  nextPlanVersion: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  generateJsonWithRetry: vi.fn(),
  generatePageDraft: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {} }) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  invalidateProjectExports: mocks.invalidateProjectExports,
  nextPlanVersion: mocks.nextPlanVersion,
  planInputSnapshot: (input: unknown) => input,
  strategyForInput: () => ({ generatePageDraft: mocks.generatePageDraft }),
  toPriorPageContext: (page: { index: number; title: string; summary: string }) => ({
    index: page.index,
    title: page.title,
    summary: page.summary
  })
}));
vi.mock("../generation/generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("../generation/pageReview.js", () => ({
  reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage
}));
vi.mock("./importBookSupport.js", () => ({ importStyleProfileFromMediaSettings: () => null }));
vi.mock("../generation/projectInput.js", () => ({
  inputForPlanVersion: (_project: unknown, snapshot: unknown) => ({
    targetPages: (snapshot as { targetPages?: number })?.targetPages ?? 10,
    temperature: 0.7,
    language: "en",
    mediaSettings: {}
  })
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: (value: unknown) => value },
    createProviders: () => ({}),
    generateJsonWithRetry: mocks.generateJsonWithRetry
  };
});

import { continueBook } from "./continueBook.js";

const basePlan = {
  premise: "A tale.",
  voiceGuide: "Warm.",
  chapters: [
    { index: 1, title: "One", summary: "s1", targetPages: 5, keyBeats: [] },
    { index: 2, title: "Two", summary: "s2", targetPages: 5, keyBeats: [] }
  ]
};

const REQUEST = "Add two more chapters";

const job = (data: Record<string, unknown> = {}) =>
  ({
    id: "job-1",
    data: {
      projectId: "project-1",
      operationId: "op-1",
      request: REQUEST,
      planId: "plan-base",
      chapterCount: 1,
      newPageCount: 2,
      ...data
    }
  }) as unknown as Job;

const baseProject = {
  id: "project-1",
  currentPlanId: "plan-base",
  targetPages: 10,
  title: "Book",
  language: "en",
  mediaSettings: {},
  status: "COMPLETE"
};

function mockTransactions() {
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx));
}

function trailingPage(index: number) {
  return { index, title: `Page ${index}`, markdown: "Text.", summary: `Summary ${index}.` };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTransactions();
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "ACTIVE" });
  mocks.prisma.bookEditOperation.update.mockResolvedValue({});
  mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.getProjectOrThrow.mockResolvedValue(baseProject);
  mocks.prisma.planVersion.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "plan-base"
      ? { id: "plan-base", inputSnapshot: { targetPages: 10 }, planningPackage: basePlan }
      : where.id === "plan-stranded"
        ? { id: "plan-stranded", messages: [{ role: "user", content: `Continue the book: ${REQUEST}` }] }
        : null
  );
  // No stranded rows unless a test says otherwise.
  mocks.prisma.chapter.findMany.mockResolvedValue([]);
  mocks.prisma.page.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if (args.where.chapterId) {
      return [{ index: 11 }, { index: 12 }];
    }
    if (args.where.status === "COMPLETED" && !args.where.index) {
      return [trailingPage(10), trailingPage(9)];
    }
    return [];
  });
  mocks.prisma.page.findFirst.mockResolvedValue({ index: 10 });
  mocks.prisma.chapter.findFirst.mockResolvedValue({ index: 2 });
  mocks.prisma.chapter.findUnique.mockResolvedValue({ id: "ch-new" });
  mocks.prisma.chapter.update.mockResolvedValue({});
  mocks.generateJsonWithRetry.mockResolvedValue({
    data: { chapters: [{ title: "New chapter", summary: "Fresh.", keyBeats: [] }] }
  });
  mocks.nextPlanVersion.mockResolvedValue(4);
  mocks.tx.planVersion.create.mockResolvedValue({ id: "plan-new" });
  mocks.tx.chapter.create.mockResolvedValue({ id: "ch-new" });
  mocks.generatePageDraft.mockResolvedValue({ title: "Draft", markdown: "Draft text.", summary: "Draft summary." });
  mocks.reviewAndSaveGeneratedPage.mockImplementation(
    async ({ draft }: { draft: { index: number } }) => ({
      index: draft.index,
      title: `Page ${draft.index}`,
      markdown: "Saved.",
      summary: `Saved ${draft.index}.`
    })
  );
  mocks.invalidateProjectExports.mockResolvedValue(undefined);
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
});

describe("continueBook redelivery fence", () => {
  it("cleans a crashed delivery's stranded append instead of appending on top", async () => {
    // A mid-run crash left: the continuation plan installed as current, an
    // appended chapter 3 with pages 11-12, and targetPages inflated to 12.
    mocks.getProjectOrThrow
      .mockResolvedValueOnce({ ...baseProject, currentPlanId: "plan-stranded", targetPages: 12 })
      .mockResolvedValue(baseProject);
    mocks.prisma.chapter.findMany.mockResolvedValue([{ id: "ch-stranded" }]);

    await continueBook(job());

    // The stranded rows are removed against the payload's pre-continuation
    // plan boundary (chapter 2), and the base plan is restored as current.
    expect(mocks.tx.page.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", chapterId: { in: ["ch-stranded"] } }
    });
    expect(mocks.tx.chapter.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", index: { gt: 2 } }
    });
    expect(mocks.tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { currentPlanId: "plan-base", targetPages: 10 }
    });
    expect(mocks.tx.planVersion.deleteMany).toHaveBeenCalledWith({
      where: { id: "plan-stranded", projectId: "project-1" }
    });

    // The rebuilt continuation starts at the ORIGINAL boundary: pages 11-12
    // again, not 13-14 stacked on the stranded copy.
    const createdPages = mocks.tx.page.createMany.mock.calls[0]?.[0] as {
      data: Array<{ index: number }>;
    };
    expect(createdPages.data.map((page) => page.index)).toEqual([11, 12]);
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED", affectedPageIndexes: [11, 12] }) })
    );
  });

  it("appends normally when no stranded rows exist", async () => {
    await continueBook(job());

    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.planVersion.deleteMany).not.toHaveBeenCalled();
    const createdPages = mocks.tx.page.createMany.mock.calls[0]?.[0] as {
      data: Array<{ index: number }>;
    };
    expect(createdPages.data.map((page) => page.index)).toEqual([11, 12]);
  });

  it("refuses to guess when chapters past the plan belong to no known continuation", async () => {
    mocks.getProjectOrThrow.mockResolvedValue({ ...baseProject, currentPlanId: "plan-mystery" });
    mocks.prisma.chapter.findMany.mockResolvedValue([{ id: "ch-stranded" }]);
    mocks.prisma.planVersion.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "plan-base"
        ? { id: "plan-base", inputSnapshot: { targetPages: 10 }, planningPackage: basePlan }
        : { id: "plan-mystery", messages: [{ role: "user", content: "Something else" }] }
    );

    await expect(continueBook(job())).rejects.toThrow("does not own");
    expect(mocks.tx.page.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.page.createMany).not.toHaveBeenCalled();
  });

  it("replays only the success tail when the operation is already APPLIED", async () => {
    // The append finished and the crash landed before the durable COMPLETED
    // write: the book already contains the continuation, so a second append
    // would deliver it twice.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "APPLIED" });
    mocks.getProjectOrThrow.mockResolvedValue({ ...baseProject, currentPlanId: "plan-new" });

    await continueBook(job());

    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "COMPLETE", contentRevision: { increment: 1 } }
    });
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-new");
    // Nothing is outlined, appended, or re-marked ACTIVE.
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
  });
});

describe("continueBook compensation", () => {
  it("moves an APPLIED operation to FAILED when the append is rolled back", async () => {
    // The failure lands after the operation was marked APPLIED (the export
    // refresh); the compensation deletes the appended pages, so an operation
    // left APPLIED would name pages the book no longer contains.
    mocks.invalidateProjectExports.mockRejectedValue(new Error("disk gone"));

    await expect(continueBook(job())).rejects.toThrow("disk gone");

    // The rollback ran…
    expect(mocks.tx.page.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", index: { gt: 10 } }
    });
    expect(mocks.tx.planVersion.delete).toHaveBeenCalledWith({ where: { id: "plan-new" } });
    // …and the operation's verdict follows the rollback, guarded on APPLIED so
    // the normal QUEUED/ACTIVE settlement (and its refund gate) is untouched.
    expect(mocks.prisma.bookEditOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "op-1", status: "APPLIED" },
      data: { status: "FAILED", error: "disk gone", affectedPageIndexes: [] }
    });
  });

  it("does not flip an operation that never reached APPLIED", async () => {
    mocks.reviewAndSaveGeneratedPage.mockRejectedValue(new Error("model outage"));

    await expect(continueBook(job())).rejects.toThrow("model outage");

    // The guarded updateMany may run, but only against the APPLIED status —
    // an ACTIVE operation stays claimable by failEditOperation, whose claim is
    // what gates the legacy (attempt-less) refund path.
    for (const call of mocks.prisma.bookEditOperation.updateMany.mock.calls) {
      expect((call[0] as { where: { status: string } }).where.status).toBe("APPLIED");
    }
  });
});
