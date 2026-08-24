import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());

import {
  EXPORT_PUBLICATION_PROJECT_STATUS,
  PRESENTATION_ONLY_RECOMPILE,
  PRESENTATION_RECOMPILE_FALLBACK_STATUS,
  type SettledProjectStatus
} from "@book-maker/core";

import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { applyPresentationPreference } from "./presentationEdits.js";
import {
  jobRecord,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { mockTransactions } from "./testing/mobileApiMocks.js";

describe("presentation edit compile policy", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it.each(["REVIEW_REQUIRED", "COMPLETE"] satisfies SettledProjectStatus[])(
    "preserves %s across a second presentation edit while the first compile is open",
    async (fallbackStatus) => {
      mockPrisma.project.update.mockResolvedValueOnce({
        contentRevision: 8,
        currentPlanId: "plan-1",
        mediaSettings: { includeSources: true },
        status: "EDITING"
      });
      mockPrisma.generationJob.findFirst.mockResolvedValueOnce({
        payload: {
          planId: "plan-1",
          contentRevision: 7,
          skipFinalReview: true,
          [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING",
          [PRESENTATION_ONLY_RECOMPILE]: true,
          [PRESENTATION_RECOMPILE_FALLBACK_STATUS]: fallbackStatus
        }
      });
      vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
        jobRecord({ id: "compile-second", type: "COMPILE_EXPORT" })
      );

      await applyPresentationPreference(
        projectRecord({
          id: "project-1",
          status: "EDITING",
          contentRevision: 7,
          currentPlanId: "plan-1"
        }) as unknown as Parameters<typeof applyPresentationPreference>[0],
        { includeSources: false }
      );

      expect(mockPrisma.generationJob.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: "project-1",
          type: "COMPILE_EXPORT",
          // Derived from the revision returned by the locking update, not the
          // caller's potentially stale pre-transaction project snapshot.
          contentRevision: 7,
          payload: { path: [PRESENTATION_ONLY_RECOMPILE], equals: true }
        },
        orderBy: { createdAt: "desc" },
        select: { payload: true }
      });
      expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
        expect.objectContaining({
          contentRevision: 8,
          payload: expect.objectContaining({
            [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING",
            [PRESENTATION_ONLY_RECOMPILE]: true,
            [PRESENTATION_RECOMPILE_FALLBACK_STATUS]: fallbackStatus
          })
        })
      );
      expect(vi.mocked(dispatchGenerationJob)).toHaveBeenCalledWith("compile-second");
    }
  );

  it("merges concurrent Sources and chapter-heading preferences onto the row that won the lock", async () => {
    const mediaSettings = {
      includeSources: true,
      chapterHeadingStyle: "numbered",
      chapterHeadingLabel: "Chapter"
    };
    const live = {
      contentRevision: 0,
      currentPlanId: "plan-1",
      mediaSettings: { ...mediaSettings },
      status: "COMPLETE" as "COMPLETE" | "EDITING"
    };
    let claimCount = 0;
    let transactionCount = 0;
    let finishFirstTransaction!: () => void;
    const firstTransactionFinished = new Promise<void>((resolve) => {
      finishFirstTransaction = resolve;
    });

    // Both callbacks start from the same caller snapshot. The second locking
    // UPDATE waits for the first transaction to commit, just as PostgreSQL
    // does, and then returns the row version the first preference wrote.
    mockPrisma.$transaction.mockImplementation(async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
      const transactionNumber = ++transactionCount;
      try {
        return await operation(mockPrisma);
      } finally {
        if (transactionNumber === 1) {
          finishFirstTransaction();
        }
      }
    });
    mockPrisma.project.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.contentRevision !== undefined) {
        const claimNumber = ++claimCount;
        if (claimNumber === 2) {
          await firstTransactionFinished;
        }
        live.contentRevision += 1;
      }
      if (data.mediaSettings !== undefined) {
        live.mediaSettings = { ...(data.mediaSettings as typeof mediaSettings) };
      }
      if (data.status === "EDITING") {
        live.status = "EDITING";
      }
      return {
        contentRevision: live.contentRevision,
        currentPlanId: live.currentPlanId,
        mediaSettings: { ...live.mediaSettings },
        status: live.status
      };
    });

    const compilePayloads: Array<Record<string, unknown>> = [];
    vi.mocked(enqueueGenerationJob).mockImplementation(async (options) => {
      compilePayloads.push(options.payload as Record<string, unknown>);
      return jobRecord({ id: `compile-${compilePayloads.length}`, type: "COMPILE_EXPORT" });
    });
    mockPrisma.generationJob.findFirst.mockImplementation(async () => {
      const payload = compilePayloads.at(-1);
      return payload ? { payload } : null;
    });

    const staleProject = () => projectRecord({
      id: "project-1",
      status: "COMPLETE",
      contentRevision: 0,
      currentPlanId: "plan-1",
      mediaSettings: { ...mediaSettings }
    }) as unknown as Parameters<typeof applyPresentationPreference>[0];

    await Promise.all([
      applyPresentationPreference(staleProject(), { includeSources: false }),
      applyPresentationPreference(staleProject(), {
        chapterHeadingStyle: "title_only",
        chapterHeadingLabel: null
      })
    ]);

    expect(live.mediaSettings).toEqual({
      includeSources: false,
      chapterHeadingStyle: "title_only",
      chapterHeadingLabel: null
    });
    const lockingUpdates = mockPrisma.project.update.mock.calls.filter(
      ([options]) => options.data.contentRevision !== undefined
    );
    expect(lockingUpdates).toHaveLength(2);
    expect(lockingUpdates.every(([options]) => options.data.mediaSettings === undefined)).toBe(true);
    expect(compilePayloads[1]).toMatchObject({
      planId: "plan-1",
      contentRevision: 2,
      [PRESENTATION_RECOMPILE_FALLBACK_STATUS]: "COMPLETE"
    });
    expect(vi.mocked(dispatchGenerationJob)).toHaveBeenCalledWith("compile-1");
    expect(vi.mocked(dispatchGenerationJob)).toHaveBeenCalledWith("compile-2");
  });

  it("rolls back instead of assuming COMPLETE when EDITING has no presentation policy", async () => {
    mockPrisma.project.update.mockResolvedValueOnce({
      contentRevision: 8,
      currentPlanId: "plan-1",
      mediaSettings: { includeSources: true },
      status: "EDITING"
    });
    mockPrisma.generationJob.findFirst.mockResolvedValueOnce(null);

    await expect(
      applyPresentationPreference(
        projectRecord({
          id: "project-1",
          status: "EDITING",
          contentRevision: 7,
          currentPlanId: "plan-1"
        }) as unknown as Parameters<typeof applyPresentationPreference>[0],
        { includeSources: false }
      )
    ).rejects.toThrow("Cannot recover presentation compile policy");

    expect(mockTransactions()).toHaveLength(1);
    expect(mockTransactions()[0]).toMatchObject({ rolledBack: true });
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(vi.mocked(dispatchGenerationJob)).not.toHaveBeenCalled();
  });
});
