import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  application: {} as Record<string, unknown>,
  restoredPlanId: "plan-1" as string | null,
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    $transaction: vi.fn()
  },
  applyStructuralPageChange: vi.fn(),
  waitForStructuralPageLease: vi.fn(),
  waitForStructuralPageLeaseCompletion: vi.fn(),
  heartbeatAssertHeld: vi.fn(),
  heartbeatStop: vi.fn(),
  completeStructuralPageLease: vi.fn(),
  markStructuralPageLeaseApplied: vi.fn(),
  renewStructuralPageLeaseTx: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn(),
  generatePageDraft: vi.fn(),
  rebuildProjectStoryState: vi.fn(),
  rebuildRolledBackProjectStoryState: vi.fn(),
  revertStructuralPageChange: vi.fn(),
  refundUnwrittenEditPages: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { DbNull: Symbol("DbNull") },
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: {},
  revertStructuralPageChange: mocks.revertStructuralPageChange
}));
vi.mock("../generation/pageRestructure.js", () => ({
  applyStructuralPageChange: mocks.applyStructuralPageChange
}));
vi.mock("../generation/structuralPageLease.js", () => ({
  waitForStructuralPageLease: mocks.waitForStructuralPageLease,
  waitForStructuralPageLeaseCompletion: mocks.waitForStructuralPageLeaseCompletion,
  startStructuralPageLeaseHeartbeat: () => ({ assertHeld: mocks.heartbeatAssertHeld, stop: mocks.heartbeatStop }),
  completeStructuralPageLease: mocks.completeStructuralPageLease,
  markStructuralPageLeaseApplied: mocks.markStructuralPageLeaseApplied,
  renewStructuralPageLeaseTx: mocks.renewStructuralPageLeaseTx,
  releaseStructuralPageLease: vi.fn(),
  isStructuralPageLeaseLostError: () => false
}));
vi.mock("../generation/pageReview.js", () => ({ reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async () => ({ id: "project-1", currentPlanId: "plan-1", status: "EDITING", targetPages: 4 }),
  invalidateProjectExports: vi.fn(),
  strategyForInput: () => ({ generatePageDraft: mocks.generatePageDraft }),
  styleExcerptsForPage: async () => [],
  toPriorPageContext: (page: unknown) => page
}));
vi.mock("../generation/generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({ targetPages: 4 }) }));
vi.mock("../generation/qualitySettings.js", () => ({ loadQualityContext: async () => ({ enabled: () => false }) }));
vi.mock("../generation/storyStateStore.js", () => ({
  rebuildProjectStoryState: mocks.rebuildProjectStoryState,
  rebuildRolledBackProjectStoryState: mocks.rebuildRolledBackProjectStoryState
}));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {} }) }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/dispatch.js", () => ({
  maybeEnqueueCompile: vi.fn(),
  redeliverWorkerGenerationJob: vi.fn()
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  refundSkippedEditOperation: vi.fn(),
  refundUnwrittenEditPages: mocks.refundUnwrittenEditPages
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: (value: unknown) => ({ chapters: [], promises: (value as { promises?: string[] }).promises ?? [] }) },
    createProviders: () => ({})
  };
});

import { restructurePages } from "./restructurePages.js";

const pages = Array.from({ length: 4 }, (_value, index) => ({
  id: `page-${index + 1}`,
  index: index + 1,
  chapterId: null
}));

const structuralApplication = (action: "insert" | "delete" | "move") => ({
  action,
  pageOrderBefore: pages.map((page) => ({ ...page, pageId: page.id })),
  insertedPageIds: action === "insert" ? ["page-new"] : [],
  removedPages: [],
  basePlanVersionId: "plan-1",
  newPlanVersionId: "plan-2",
  previousTargetPages: 4,
  previousChapterTargetPages: {},
  appliedAt: "2026-08-18T00:00:00.000Z"
});

const requestFor = (action: "insert" | "delete" | "move") => {
  const structuralEdit = action === "insert"
    ? { action, anchorPageIndex: 2, pageIndexes: [], pageCount: 1 }
    : action === "delete"
      ? { action, anchorPageIndex: 0, pageIndexes: [2], pageCount: 0 }
      : { action, anchorPageIndex: 4, pageIndexes: [2], pageCount: 0 };
  return {
    data: {
      projectId: "project-1",
      operationId: "op-1",
      request: `${action} pages`,
      planId: "plan-1",
      structuralEdit
    },
    id: "job-1"
  } as unknown as Job;
};

describe("restructurePages rollback story state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.restoredPlanId = "plan-1";
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.prisma));
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "ACTIVE", classifier: {} });
    mocks.prisma.project.update.mockResolvedValue({});
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-2",
      inputSnapshot: {},
      planningPackage: { promises: ["Changed-book promise"] }
    });
    mocks.prisma.page.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id ? [{ index: 3 }] : where.index ? [] : pages
    );
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-new", index: 3, chapterId: null, chapter: null
    });
    mocks.prisma.page.count.mockResolvedValue(1);
    mocks.applyStructuralPageChange.mockImplementation(async () => ({
      outcome: "applied",
      application: mocks.application
    }));
    mocks.generatePageDraft.mockResolvedValue({ title: "New", markdown: "Body", summary: "Summary", continuityNotes: [] });
    mocks.reviewAndSaveGeneratedPage.mockResolvedValue({});
    mocks.rebuildProjectStoryState.mockResolvedValue({});
    mocks.rebuildRolledBackProjectStoryState.mockResolvedValue({});
    mocks.refundUnwrittenEditPages.mockResolvedValue(undefined);
    mocks.markStructuralPageLeaseApplied.mockRejectedValue(new Error("settlement write failed"));
    mocks.renewStructuralPageLeaseTx.mockResolvedValue({ status: "ACTIVE", classifier: {} });
    mocks.revertStructuralPageChange.mockImplementation(async () => ({ currentPlanId: mocks.restoredPlanId }));
  });

  it.each(["insert", "delete", "move"] as const)(
    "stamps the publication owner for a successful structural %s",
    async (action) => {
      mocks.application = structuralApplication(action);
      mocks.markStructuralPageLeaseApplied.mockResolvedValue(true);
      mocks.completeStructuralPageLease.mockResolvedValue(true);

      await expect(
        restructurePages(requestFor(action), { id: "op-1", status: "QUEUED", classifier: {} })
      ).resolves.toBeUndefined();

      expect(mocks.markStructuralPageLeaseApplied).toHaveBeenCalledWith({
        projectId: "project-1",
        operationId: "op-1",
        ownerToken: expect.any(String),
        affectedPageIndexes: expect.any(Array)
      });
      expect(mocks.revertStructuralPageChange).not.toHaveBeenCalled();
    }
  );

  it.each(["insert", "delete", "move"] as const)(
    "restores story state after a %s rollback that follows a successful forward rebuild",
    async (action) => {
      mocks.application = structuralApplication(action);
      if (action === "move") mocks.restoredPlanId = "plan-3";

      await expect(
        restructurePages(requestFor(action), { id: "op-1", status: "QUEUED", classifier: {} })
      ).rejects.toThrow("settlement write failed");

      expect(mocks.rebuildProjectStoryState).toHaveBeenCalledWith("project-1", ["Changed-book promise"]);
      expect(mocks.revertStructuralPageChange).toHaveBeenCalledWith(
        mocks.prisma,
        "project-1",
        expect.objectContaining({ action })
      );
      expect(mocks.rebuildRolledBackProjectStoryState).toHaveBeenCalledWith("project-1", mocks.restoredPlanId);
      expect(mocks.rebuildProjectStoryState.mock.invocationCallOrder[0]!).toBeLessThan(
        mocks.rebuildRolledBackProjectStoryState.mock.invocationCallOrder[0]!
      );
    }
  );

  /**
   * The APPLIED → FAILED flip after a rollback is the sixth writer of
   * `BookEditOperation.error`, and it was the last one still storing
   * `errorMessage(error)`: the column is copied onto the mobile DTO, so a
   * Prisma code or a null-deref inside the shift was drawn on the reader's
   * failed edit card. It takes the shared verdict now, like every other write
   * that fails one of these rows.
   */
  it("fails the rolled-back operation in the reader's words, not the cause's", async () => {
    mocks.application = structuralApplication("insert");

    await expect(
      restructurePages(requestFor("insert"), { id: "op-1", status: "QUEUED", classifier: {} })
    ).rejects.toThrow("settlement write failed");

    expect(mocks.prisma.bookEditOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "op-1", status: "APPLIED" },
      data: {
        status: "FAILED",
        error: "That change couldn’t be finished. Send it again to try once more.",
        affectedPageIndexes: [],
        structuralLeaseToken: null,
        structuralLeaseExpiresAt: null
      }
    });
  });

  it("does not rebuild when a stale owner cannot commit the rollback", async () => {
    mocks.application = structuralApplication("move");
    mocks.renewStructuralPageLeaseTx.mockResolvedValue(null);

    await expect(
      restructurePages(requestFor("move"), { id: "op-1", status: "ACTIVE", classifier: {} })
    ).resolves.toBeUndefined();

    expect(mocks.rebuildProjectStoryState).toHaveBeenCalledOnce();
    expect(mocks.revertStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.rebuildRolledBackProjectStoryState).not.toHaveBeenCalled();
  });

  it("does not rebuild when rollback cleanup fails", async () => {
    mocks.application = structuralApplication("delete");
    mocks.revertStructuralPageChange.mockRejectedValue(new Error("rollback deadlock"));

    await expect(
      restructurePages(requestFor("delete"), { id: "op-1", status: "QUEUED", classifier: {} })
    ).rejects.toThrow(/requeued to resume/);

    expect(mocks.rebuildRolledBackProjectStoryState).not.toHaveBeenCalled();
  });

  it("logs a restoration failure without masking the original handler error", async () => {
    mocks.application = structuralApplication("insert");
    mocks.rebuildRolledBackProjectStoryState.mockRejectedValue(new Error("story rebuild failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      restructurePages(requestFor("insert"), { id: "op-1", status: "QUEUED", classifier: {} })
    ).rejects.toThrow("settlement write failed");

    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("Failed to restore story state"),
      expect.objectContaining({ message: "story rebuild failed" })
    );
    logged.mockRestore();
  });
});
