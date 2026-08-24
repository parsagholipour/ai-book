import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { FinalBookQa, ManuscriptQualityReport, PageQualityReport } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

/**
 * The final-QA repair publication fence at the write boundary.
 *
 * The ordinary fence read is deliberately advisory: an edit can commit after
 * it answers and before the page update. These cases put that exact commit in
 * the gap and require the page row and an accepted chapter-brief repair to be
 * behind the same revision claim.
 */

vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/config.js", async () => (await import("./testing/compileExportMocks.js")).configModuleMock());
vi.mock(
  "../generation/projectInput.js",
  async () => (await import("./testing/compileExportMocks.js")).projectInputModuleMock()
);
vi.mock(
  "../generation/exportPublication.js",
  async () => (await import("./testing/compileExportMocks.js")).exportPublicationModuleMock()
);
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/compileExportMocks.js")).dispatchModuleMock());
vi.mock(
  "../runtime/jobLifecycle.js",
  async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock()
);
vi.mock(
  "../providers/loggedAdapters.js",
  async () => (await import("./testing/compileExportMocks.js")).loggedAdaptersModuleMock()
);
vi.mock(
  "../generation/embeddingWrites.js",
  async () => (await import("./testing/compileExportMocks.js")).embeddingWritesModuleMock()
);
vi.mock(
  "../generation/entityState.js",
  async () => (await import("./testing/compileExportMocks.js")).entityStateModuleMock()
);
vi.mock("./characters.js", async () => (await import("./testing/compileExportMocks.js")).charactersModuleMock());
vi.mock(
  "../generation/bookHelpers.js",
  async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock()
);
vi.mock("../generation/finalQaPageTargets.js", async () => {
  const actual =
    await vi.importActual<typeof import("../generation/finalQaPageTargets.js")>(
      "../generation/finalQaPageTargets.js"
    );
  return (await import("./testing/compileExportMocks.js")).finalQaPageTargetsModuleMock(actual);
});
vi.mock(
  "../generation/storyStateStore.js",
  async () => (await import("./testing/compileExportMocks.js")).storyStateStoreModuleMock()
);
vi.mock(
  "../generation/qualityEnrichment.js",
  async () => (await import("./testing/compileExportMocks.js")).qualityEnrichmentModuleMock()
);
vi.mock(
  "../generation/qualitySettings.js",
  async () => (await import("./testing/compileExportMocks.js")).qualitySettingsModuleMock()
);
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return (await import("./testing/compileExportMocks.js")).pageReviewModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
});

import { compileExport } from "./compileExport.js";
import { qualityReportWithProvenance } from "./compileExportQualityProvenance.js";
import { exportRepairOwnershipFence, ExportRepairSupersededError } from "./compileExportFence.js";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { pageIllustrationKeeperToken } from "../generation/pageIllustrationOwnership.js";
import { mocks } from "./testing/compileExportMocks.js";

const approvedReport = (approved: boolean): PageQualityReport =>
  ({
    approved,
    score: approved ? 90 : 40,
    issues: [],
    requiredRevisions: [],
    notes: "",
    checks: { repetitionOk: true, progressionOk: true }
  }) as unknown as PageQualityReport;

const draft = {
  title: "Repaired",
  markdown: "Repaired prose.",
  summary: "Repaired summary.",
  imagePrompt: null,
  continuityNotes: [] as string[]
};

const illustratedDraft = {
  ...draft,
  imagePrompt: "A repaired scene.",
  continuityNotes: ["Mara keeps the brass key."]
};

const page = (chapter = false): ExportPageForRepair =>
  ({
    id: "page-1",
    index: 1,
    title: "Page 1",
    markdown: "Original prose.",
    summary: "Original summary.",
    imagePrompt: null,
    revision: 1,
    status: "COMPLETED",
    images: [],
    chapter: chapter ? { id: "chapter-1", index: 1, productionBrief: {} } : null
  }) as unknown as ExportPageForRepair;

const input = {
  title: "Book",
  prompt: "A book.",
  category: "fiction",
  targetPages: 1,
  complexity: 3,
  temperature: 0.6,
  language: "en",
  mediaSettings: { finalReview: true }
};
const plan = { title: "Book", premise: "A book.", audience: "adults", chapters: [] };
const finalQa = {
  approved: false,
  score: 40,
  issues: [],
  requiredFixes: [],
  notes: "",
  repairPageIndexes: [1]
} as unknown as FinalBookQa;
const strategy = {
  executionMode: "whole-book",
  reviewPageDraft: vi.fn(),
  revisePageDraft: vi.fn(),
  repairPageBrief: vi.fn(),
  shouldIllustratePage: vi.fn(() => false)
};
const ownership = () => exportRepairOwnershipFence("project-1", 4)!;
const repairOptions = (bookPage: ExportPageForRepair, overrides: Record<string, unknown> = {}) =>
  ({
    projectId: "project-1",
    input,
    plan,
    providers: { text: {}, embedding: {} },
    strategy,
    quality: { enabled: (): boolean => false },
    pages: [bookPage],
    finalQa,
    assertOwnership: ownership(),
    generationJobId: "gj-1",
    ...overrides
  }) as never;

describe("compile final-QA repair atomic publication fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.parseChapterBrief.mockReturnValue(undefined);
    mocks.loadPagesForExport.mockResolvedValue([page()]);
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: (): boolean => false });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.revisePageDraftWithRestart.mockResolvedValue(draft);
    strategy.revisePageDraft.mockResolvedValue(draft);
    strategy.reviewPageDraft.mockResolvedValue(approvedReport(true));
    strategy.repairPageBrief.mockReset();
    strategy.shouldIllustratePage.mockReturnValue(false);
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...page(),
      ...data,
      revision: 2,
      updatedAt: new Date("2026-01-01T00:00:00.001Z")
    }));
  });

  it("retires only the prior generated keeper, queues its replacement, and stands export down", async () => {
    const original = {
      ...page(),
      imagePrompt: "The old scene.",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    } as ExportPageForRepair & { updatedAt: Date };
    const oldToken = pageIllustrationKeeperToken({
      projectId: "project-1",
      pageId: original.id,
      title: original.title,
      markdown: original.markdown,
      summary: original.summary,
      imagePrompt: original.imagePrompt,
      revision: original.revision
    });
    mocks.revisePageDraftWithRestart.mockResolvedValue({ ...illustratedDraft, continuityNotes: [] });
    strategy.reviewPageDraft.mockResolvedValue(approvedReport(true));
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.prisma.imageAsset.findMany.mockResolvedValue([
      {
        id: "generated-old",
        path: `/assets/images/project-1/page-page-1-${oldToken}.webp`,
        metadata: { keeperToken: oldToken }
      },
      {
        id: "manual-replacement",
        path: "/assets/images/project-1/page-1-edit-operation.webp",
        metadata: { operationId: "edit-operation" }
      }
    ]);

    await expect(
      repairPagesFromFinalQa(repairOptions(original, { planId: "plan-1" }))
    ).rejects.toBeInstanceOf(ExportRepairSupersededError);

    expect(mocks.prisma.imageAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["generated-old"] }, projectId: "project-1", pageId: "page-1" }
    });
    expect(mocks.prisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "page-1",
          status: "COMPLETED",
          title: "Page 1",
          markdown: "Original prose.",
          summary: "Original summary.",
          imagePrompt: "The old scene.",
          revision: 1,
          updatedAt: original.updatedAt
        },
        data: expect.objectContaining({ status: "GENERATING" })
      })
    );
    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          projectId: "project-1",
          type: "GENERATE_IMAGE",
          payload: expect.objectContaining({
            pageId: "page-1",
            planId: "plan-1",
            prompt: "A repaired scene.",
            keeperToken: expect.stringMatching(/^v2-/)
          })
        })
      })
    );
    expect(mocks.dispatchWorkerGenerationJob).toHaveBeenCalledWith("image-job-1");
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "page-1", status: "GENERATING" }),
        data: expect.objectContaining({ status: "COMPLETED" })
      })
    );
    expect(mocks.prisma.page.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatchWorkerGenerationJob.mock.invocationCallOrder[0]!
    );
    expect(mocks.loadPagesForExport).not.toHaveBeenCalled();
  });

  it("keeps the durable image job and stands down when immediate queue dispatch fails", async () => {
    const original = {
      ...page(),
      imagePrompt: "The old scene.",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    } as ExportPageForRepair & { updatedAt: Date };
    mocks.revisePageDraftWithRestart.mockResolvedValue(illustratedDraft);
    strategy.reviewPageDraft.mockResolvedValue(approvedReport(true));
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.dispatchWorkerGenerationJob.mockRejectedValueOnce(new Error("redis unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        repairPagesFromFinalQa(repairOptions(original, { planId: "plan-1" }))
      ).rejects.toBeInstanceOf(ExportRepairSupersededError);
    } finally {
      warning.mockRestore();
    }

    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.generationJob.findUnique).toHaveBeenCalledWith({
      where: { id: "image-job-1" },
      select: { projectId: true, type: true, status: true, payload: true }
    });
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
  });

  it("rolls the keeper stage back when the durable job does not exactly own its token", async () => {
    const original = {
      ...page(),
      imagePrompt: "The old scene.",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    } as ExportPageForRepair & { updatedAt: Date };
    mocks.revisePageDraftWithRestart.mockResolvedValue(illustratedDraft);
    strategy.reviewPageDraft.mockResolvedValue(approvedReport(true));
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.prisma.generationJob.findUnique.mockResolvedValueOnce({
      projectId: "project-1",
      type: "GENERATE_IMAGE",
      status: "QUEUED",
      payload: {
        pageId: "page-1",
        planId: "plan-1",
        prompt: "A repaired scene.",
        keeperToken: "v2-not-this-keeper"
      }
    });

    await expect(
      repairPagesFromFinalQa(repairOptions(original, { planId: "plan-1" }))
    ).rejects.toBeInstanceOf(ExportRepairSupersededError);

    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchWorkerGenerationJob).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
  });

  it("retries cleanly when durable image-job creation rolls the staged transaction back", async () => {
    const original = {
      ...page(),
      imagePrompt: "The old scene.",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    } as ExportPageForRepair & { updatedAt: Date };
    mocks.revisePageDraftWithRestart.mockResolvedValue(illustratedDraft);
    strategy.reviewPageDraft.mockResolvedValue(approvedReport(true));
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.prisma.generationJob.upsert.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      repairPagesFromFinalQa(repairOptions(original, { planId: "plan-1" }))
    ).rejects.toThrow("database unavailable");
    expect(mocks.dispatchWorkerGenerationJob).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();

    await expect(
      repairPagesFromFinalQa(repairOptions(original, { planId: "plan-1" }))
    ).rejects.toBeInstanceOf(ExportRepairSupersededError);

    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchWorkerGenerationJob).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
  });

  it("rolls back a pre-finalization crash and lets redelivery publish one complete lifecycle", async () => {
    const original = {
      ...page(),
      imagePrompt: "The old scene.",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    } as ExportPageForRepair & { updatedAt: Date };
    mocks.revisePageDraftWithRestart.mockResolvedValue({ ...illustratedDraft, continuityNotes: [] });
    strategy.reviewPageDraft.mockResolvedValue(approvedReport(true));
    strategy.shouldIllustratePage.mockReturnValue(true);
    // This statement runs after the nonterminal page write and durable-job
    // upsert, but inside their transaction. A process/database loss here must
    // expose none of those writes and leave the original snapshot retryable.
    mocks.prisma.page.updateMany.mockRejectedValueOnce(new Error("worker lost before terminalization"));

    await expect(
      repairPagesFromFinalQa(repairOptions(original, { planId: "plan-1" }))
    ).rejects.toThrow("worker lost before terminalization");
    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchWorkerGenerationJob).not.toHaveBeenCalled();

    await expect(
      repairPagesFromFinalQa(repairOptions(original, { planId: "plan-1" }))
    ).rejects.toBeInstanceOf(ExportRepairSupersededError);

    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchWorkerGenerationJob).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.updateMany.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.dispatchWorkerGenerationJob.mock.invocationCallOrder[0]!
    );
  });

  it("stands down when the exact page snapshot changes without moving contentRevision", async () => {
    const original = {
      ...page(),
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    } as ExportPageForRepair & { updatedAt: Date };
    mocks.prisma.page.update.mockRejectedValueOnce({ code: "P2025" });

    await expect(repairPagesFromFinalQa(repairOptions(original))).rejects.toBeInstanceOf(
      ExportRepairSupersededError
    );

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", contentRevision: 4 },
      data: { contentRevision: { increment: 0 } }
    });
    expect(mocks.prisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "page-1",
          status: "COMPLETED",
          revision: 1,
          updatedAt: original.updatedAt
        })
      })
    );
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
  });

  it("does not publish exports while a repaired illustration job is outstanding", async () => {
    const original = {
      ...page(),
      imagePrompt: "The old scene.",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    } as ExportPageForRepair & { updatedAt: Date };
    mocks.inputForPlanVersion.mockReturnValue(input);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: plan, inputSnapshot: null });
    mocks.prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: "Book",
      status: "GENERATING",
      contentRevision: 4,
      authorName: null,
      mediaSettings: {},
      pages: [original],
      images: [],
      research: []
    });
    mocks.loadPagesForExport.mockResolvedValue([original]);
    mocks.loadPageTextSnapshot.mockResolvedValue([
      { index: 1, title: illustratedDraft.title, markdown: illustratedDraft.markdown, revision: 2 }
    ]);
    mocks.strategy.runFinalBookQa.mockResolvedValue(finalQa);
    mocks.revisePageDraftWithRestart.mockResolvedValue(illustratedDraft);
    Object.assign(mocks.strategy, {
      reviewPageDraft: strategy.reviewPageDraft,
      revisePageDraft: strategy.revisePageDraft,
      repairPageBrief: strategy.repairPageBrief,
      shouldIllustratePage: () => true
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = {
      id: "bull-1",
      name: "compile-export",
      data: {
        projectId: "project-1",
        planId: "plan-1",
        generationJobId: "gj-1",
        contentRevision: 4,
        exportPublicationProjectStatus: "GENERATING"
      }
    } as unknown as Job;

    try {
      const completion = await compileExport(job);
      expect(completion.lifecycleSettlement).toBe("defer-to-successor");
      expect(completion.afterJobCompleted).toEqual(expect.any(Function));
      expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
      await completion.afterJobCompleted?.();
    } finally {
      for (const key of ["reviewPageDraft", "revisePageDraft", "repairPageBrief", "shouldIllustratePage"]) {
        delete (mocks.strategy as Record<string, unknown>)[key];
      }
      warning.mockRestore();
    }

    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(
      "project-1",
      "plan-1",
      {
        review: { skipFinalReview: false, withoutQualityVerdict: false },
        expectedProjectStatus: "GENERATING",
        ownership: { kind: "outcome" }
      },
      {
        contentRevision: 4,
        completedPredecessorId: "gj-1"
      }
    );
  });

  it("stands a compile redelivery down before QA while its committed replacement image job is open", async () => {
    const repairedPage = {
      ...page(),
      ...illustratedDraft,
      status: "COMPLETED",
      revision: 2,
      updatedAt: new Date("2026-01-01T00:00:00.002Z")
    } as ExportPageForRepair & { updatedAt: Date };
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      planningPackage: plan,
      inputSnapshot: null
    });
    mocks.prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: "Book",
      status: "GENERATING",
      contentRevision: 4,
      authorName: null,
      mediaSettings: {},
      pages: [repairedPage],
      images: [],
      research: []
    });
    // Durable stage committed, but the worker died before dispatching the row
    // or throwing the illustration-deferred stand-down. This row already has a
    // report for the keeper the redelivery loaded, and a newer compile has
    // persisted another report of its own. The preflight must preserve the
    // still-current finding and must never write through the newer row.
    const currentKeeperReport = qualityReportWithProvenance(
      {
        state: "blocked",
        score: 64,
        issues: [
          {
            code: "CURRENT_KEEPER",
            severity: "error",
            source: "deterministic",
            message: "The current keeper still contains a publication-blocking defect.",
            guidance: "Repair the current keeper before publishing.",
            affectedPageIndexes: [1]
          }
        ],
        affectedPageIndexes: [1],
        checkedAt: "2026-01-01T00:00:00.000Z"
      } satisfies ManuscriptQualityReport,
      { finalReviewRan: false, reviewedPages: [repairedPage] }
    );
    const newerReport = {
      state: "passed",
      score: 100,
      issues: [],
      affectedPageIndexes: [],
      checkedAt: "2026-01-01T00:00:01.000Z"
    } satisfies ManuscriptQualityReport;
    const reports = new Map<string, unknown>([
      ["gj-1", currentKeeperReport],
      ["gj-newer", newerReport]
    ]);
    mocks.prisma.generationJob.findUnique.mockResolvedValueOnce({ qualityReport: reports.get("gj-1") });
    mocks.prisma.generationJob.update.mockImplementationOnce(
      async (args: unknown) => {
        const { where, data } = args as { where: { id: string }; data: { qualityReport: unknown } };
        reports.set(where.id, data.qualityReport);
        return { id: where.id };
      }
    );
    mocks.prisma.generationJob.count.mockResolvedValueOnce(1);
    mocks.loadPageTextSnapshot.mockResolvedValueOnce([
      {
        index: repairedPage.index,
        title: repairedPage.title,
        markdown: repairedPage.markdown,
        revision: repairedPage.revision
      }
    ]);
    const job = {
      id: "bull-1",
      name: "compile-export",
      data: {
        projectId: "project-1",
        planId: "plan-1",
        generationJobId: "gj-1",
        contentRevision: 4,
        skipFinalReview: true,
        detachedFromProjectLifecycle: true,
        exportRepairFormat: "epub",
        exportPublicationProjectStatus: "REVIEW_REQUIRED"
      }
    } as unknown as Job;

    const completion = await compileExport(job);

    expect(completion.afterJobCompleted).toEqual(expect.any(Function));
    expect(mocks.strategy.runFinalBookQa).not.toHaveBeenCalled();
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith({
      where: { id: "gj-1" },
      data: {
        qualityReport: expect.objectContaining({
          state: "blocked",
          issues: [expect.objectContaining({ code: "CURRENT_KEEPER", affectedPageIndexes: [1] })]
        })
      }
    });
    expect(reports.get("gj-1")).toEqual(
      expect.objectContaining({
        state: "blocked",
        issues: [expect.objectContaining({ code: "CURRENT_KEEPER", affectedPageIndexes: [1] })]
      })
    );
    expect(reports.get("gj-newer")).toEqual(newerReport);

    await completion.afterJobCompleted?.();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(
      "project-1",
      "plan-1",
      {
        review: { skipFinalReview: true, withoutQualityVerdict: false },
        expectedProjectStatus: "REVIEW_REQUIRED",
        ownership: { kind: "detached", repairFormat: "epub" }
      },
      {
        contentRevision: 4,
        completedPredecessorId: "gj-1"
      }
    );
  });

  it("rechecks revision ownership before the semantic tail and writes no stale memory", async () => {
    const storyExtract = { storyDelta: { factsAdded: ["Mara has the key."] } };
    mocks.revisePageDraftWithRestart.mockResolvedValue({ ...draft, continuityNotes: ["Mara has the key."] });
    strategy.reviewPageDraft.mockResolvedValue(approvedReport(true));
    mocks.keeperStoryExtractForSave.mockResolvedValue(storyExtract);
    mocks.prisma.project.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(repairPagesFromFinalQa(repairOptions(page()))).rejects.toBeInstanceOf(
      ExportRepairSupersededError
    );

    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    expect(mocks.updateEntityStateFromPage).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
  });

  it("prepares provider results outside transactions and publishes every semantic write under the exact keeper fence", async () => {
    const storyExtract = { storyDelta: { factsAdded: ["Mara has the key."] } };
    let transactionOpen = false;
    const transactionImplementation = mocks.prisma.$transaction.getMockImplementation();
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
      transactionOpen = true;
      try {
        return await run(mocks.prisma);
      } finally {
        transactionOpen = false;
      }
    });
    mocks.revisePageDraftWithRestart.mockResolvedValue({
      ...draft,
      continuityNotes: ["Mara has the key."]
    });
    mocks.keeperStoryExtractForSave.mockImplementationOnce(async () => {
      expect(transactionOpen).toBe(false);
      return storyExtract;
    });
    mocks.prepareEmbedding.mockImplementationOnce(async () => {
      expect(transactionOpen).toBe(false);
      return { vectorLiteral: "[0]", error: null };
    });
    strategy.executionMode = "sequential-pages";

    try {
      await repairPagesFromFinalQa(repairOptions(page()));
    } finally {
      strategy.executionMode = "whole-book";
      if (transactionImplementation) {
        mocks.prisma.$transaction.mockImplementation(transactionImplementation);
      }
    }

    expect(mocks.persistStoryExtract).toHaveBeenCalledWith(
      expect.objectContaining({ client: mocks.prisma, extract: storyExtract })
    );
    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ pageId: "page-1", body: "Mara has the key." })]
    });
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledWith(
      "project-1",
      1,
      ["Mara has the key."],
      mocks.prisma
    );
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledWith(
      { projectId: "project-1", scope: "page:1", sourceId: "page-1", text: "Repaired summary." },
      { vectorLiteral: "[0]", error: null },
      mocks.prisma
    );
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "page-1",
          markdown: "Repaired prose.",
          revision: 2,
          status: "COMPLETED"
        })
      })
    );
  });

  it("writes neither page, brief nor semantic memory when ownership is lost after provider preparation", async () => {
    const storyExtract = { storyDelta: { factsAdded: ["Mara has the key."] } };
    mocks.revisePageDraftWithRestart.mockResolvedValue({
      ...draft,
      continuityNotes: ["Mara has the key."]
    });
    mocks.keeperStoryExtractForSave.mockResolvedValue(storyExtract);
    strategy.executionMode = "sequential-pages";
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });

    try {
      await expect(repairPagesFromFinalQa(repairOptions(page(true)))).rejects.toBeInstanceOf(
        ExportRepairSupersededError
      );
    } finally {
      strategy.executionMode = "whole-book";
    }

    expect(mocks.keeperStoryExtractForSave).toHaveBeenCalledTimes(1);
    expect(mocks.prepareEmbedding).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    expect(mocks.updateEntityStateFromPage).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
  });

  it.each([
    ["COMPLETED", true],
    ["FAILED_QA", false]
  ])("publishes no %s page when the revision changes after the prior fence", async (_status, approved) => {
    strategy.reviewPageDraft.mockResolvedValue(approvedReport(approved));
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });

    await expect(repairPagesFromFinalQa(repairOptions(page()))).rejects.toBeInstanceOf(
      ExportRepairSupersededError
    );

    expect(mocks.exportPublicationSuperseded).toHaveBeenCalled();
    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", contentRevision: 4 },
      data: { contentRevision: { increment: 0 } }
    });
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("publishes neither the page nor its repaired brief after the revision changes", async () => {
    const chapterPage = page(true);
    const storedBrief = {
      chapterIndex: 1,
      title: "One",
      summary: "Summary",
      continuityFocus: [],
      pages: [{ pageIndex: 1, purpose: "Old", beat: "Old", requiredContinuity: [], endingPressure: "" }]
    };
    mocks.parseChapterBrief.mockReturnValue(storedBrief);
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: storedBrief });
    mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 1 });
    strategy.reviewPageDraft
      .mockResolvedValueOnce({ ...approvedReport(false), checks: { repetitionOk: false, progressionOk: true } })
      .mockResolvedValueOnce({ ...approvedReport(false), checks: { repetitionOk: false, progressionOk: true } })
      .mockResolvedValue(approvedReport(true));
    strategy.repairPageBrief.mockResolvedValue({
      pageIndex: 1,
      purpose: "Fresh",
      beat: "Fresh",
      requiredContinuity: [],
      endingPressure: ""
    });
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });

    await expect(repairPagesFromFinalQa(repairOptions(chapterPage))).rejects.toBeInstanceOf(
      ExportRepairSupersededError
    );

    expect(strategy.repairPageBrief).toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
  });

  it("uses the existing stand-down verdict when the atomic page claim loses", async () => {
    const bookPage = page();
    mocks.inputForPlanVersion.mockReturnValue(input);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: plan, inputSnapshot: null });
    mocks.prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: "Book",
      status: "COMPLETE",
      contentRevision: 4,
      authorName: null,
      mediaSettings: {},
      pages: [bookPage],
      images: [],
      research: []
    });
    mocks.loadPagesForExport.mockResolvedValue([bookPage]);
    mocks.loadPageTextSnapshot.mockResolvedValue([
      { index: 1, title: bookPage.title, markdown: bookPage.markdown, revision: 1 }
    ]);
    mocks.strategy.runFinalBookQa.mockResolvedValue(finalQa);
    Object.assign(mocks.strategy, {
      reviewPageDraft: strategy.reviewPageDraft,
      revisePageDraft: strategy.revisePageDraft,
      repairPageBrief: strategy.repairPageBrief
    });
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = {
      id: "bull-1",
      name: "compile-export",
      data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", contentRevision: 4 }
    } as unknown as Job;

    try {
      await expect(compileExport(job)).resolves.toEqual({});
    } finally {
      for (const key of ["reviewPageDraft", "revisePageDraft", "repairPageBrief"]) {
        delete (mocks.strategy as Record<string, unknown>)[key];
      }
      warning.mockRestore();
    }

    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith({
      where: { id: "gj-1" },
      // The stand-down preserves the review verdict instead of letting the
      // superseded exception reach normal failure settlement.
      data: { qualityReport: expect.objectContaining({ state: "passed" }) }
    });
  });
});
