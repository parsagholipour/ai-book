import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { FinalBookQa, ManuscriptQualityReport } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

/**
 * The final-QA repair publication fence at the write boundary.
 *
 * The ordinary fence read is deliberately advisory: an edit can commit after
 * it answers and before the page update. These cases put that exact commit in
 * the gap and require the page row and an accepted chapter-brief repair to be
 * behind the same revision claim.
 */

vi.mock("./compileFinalization.js", async () => (await import("./testing/compileExportMocks.js")).compileFinalizationModuleMock());
vi.mock("../generation/finalizationIllustrations.js", async () => (await import("./testing/compileExportMocks.js")).finalizationIllustrationsModuleMock());
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
import { mocks } from "./testing/compileExportMocks.js";

/**
 * The compile's one repair, the defect screen's scoped patch (`compileQuickDraftRepair.ts`), publishes its whole
 * group in one transaction behind the revision CAS and an exact snapshot claim of every page it read. A repaired
 * illustrated page takes a new revision and loses its generated picture in that same commit, and the compile's
 * finalization draws the new keeper: nothing inside the repair queues an image. The per-page rewrite loop these
 * suites used to drive — its staged keeper, in-repair image job and semantic tail — went with the old final
 * review on 2026-10-16.
 */
const page = (overrides: Partial<ExportPageForRepair> = {}): ExportPageForRepair =>
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
    chapter: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  }) as unknown as ExportPageForRepair;

const input = {
  title: "Book",
  prompt: "A book.",
  category: "fiction",
  targetPages: 1,
  complexity: 3,
  temperature: 0.6,
  language: "en",
  mediaSettings: { modelTier: "fast" }
};
const plan = { title: "Book", premise: "A book.", audience: "adults", chapters: [] };
const finalQa = {
  approved: false,
  score: 60,
  issues: ["Page 1: A drafting note was left in."],
  requiredFixes: ["Page 1: Remove the note."],
  notes: "Focused screen.",
  focusedReview: { rejectedFindings: 0, repairGroups: [[1]], findings: [{ targets: [1], kind: "production_note",
    problem: "A drafting note was left in.", fix: "Remove the note.", evidence: [{ pageIndex: 1, quote: "Original prose." }] }] }
} as unknown as FinalBookQa;
const strategy = { executionMode: "whole-book", shouldIllustratePage: vi.fn(() => false) };
const repairOptions = (bookPage: ExportPageForRepair, overrides: Record<string, unknown> = {}) =>
  ({
    projectId: "project-1",
    planId: "plan-1",
    input,
    plan,
    providers: { text: {}, embedding: {} },
    strategy,
    pages: [bookPage],
    finalQa,
    assertOwnership: exportRepairOwnershipFence("project-1", 4)!,
    generationJobId: "gj-1",
    ...overrides
  }) as never;
const compileJob = (data: Record<string, unknown> = {}) => ({
  id: "bull-1",
  name: "compile-export",
  data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", contentRevision: 4, ...data }
}) as unknown as Job;
const stageCompile = (bookPage: ExportPageForRepair, status = "GENERATING") => {
  mocks.inputForPlanVersion.mockReturnValue(input);
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: plan, inputSnapshot: null });
  mocks.prisma.project.findUnique.mockResolvedValue({ id: "project-1", title: "Book", status, contentRevision: 4,
    authorName: null, mediaSettings: {}, pages: [bookPage], images: [], research: [] });
  mocks.loadPagesForExport.mockResolvedValue([bookPage]);
  mocks.reviewQuickDraftManuscript.mockResolvedValueOnce(finalQa as never);
};

describe("compile scoped repair atomic publication fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.loadPagesForExport.mockResolvedValue([page()]);
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "fast" as unknown as "balanced",
      enabled: (feature: string) => feature === "finalBookQa" || feature === "pageQaRewrite" });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.enqueueFinalizationIllustrations.mockResolvedValue({ kind: "ready", pendingJobIds: [], missingPageIndexes: [] });
    strategy.shouldIllustratePage.mockReturnValue(false);
    mocks.repairQuickDraftPages.mockReset().mockImplementation(async ({ pages }) =>
      pages.map((bookPage) => bookPage.index === 1 ? { ...bookPage, markdown: "Repaired prose.", summary: "Repaired summary." } : bookPage));
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...page(), ...data, revision: 2 }));
  });

  it("spends no provider call for a durably consumed repair group, or a page another delivery started", async () => {
    const started = vi.fn(async () => false);
    await expect(repairPagesFromFinalQa(repairOptions(page(), { onRepairGroupStarted: started }))).resolves.toBeUndefined();
    expect(started).toHaveBeenCalledWith([{ id: "page-1", index: 1 }]);
    await expect(repairPagesFromFinalQa(repairOptions(page(), { shouldRepairPage: () => false }))).resolves.toBeUndefined();
    expect(mocks.repairQuickDraftPages).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("stands down when the exact page snapshot changes without moving contentRevision", async () => {
    const original = page();
    mocks.prisma.page.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(repairPagesFromFinalQa(repairOptions(original))).rejects.toBeInstanceOf(ExportRepairSupersededError);

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", contentRevision: 4 },
      data: { contentRevision: { increment: 0 } }
    });
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "page-1", status: "COMPLETED", revision: 1, updatedAt: (original as unknown as { updatedAt: Date }).updatedAt })
    }));
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
  });

  it("publishes no page when the revision changes after the prior fence", async () => {
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });

    await expect(repairPagesFromFinalQa(repairOptions(page()))).rejects.toBeInstanceOf(ExportRepairSupersededError);

    expect(mocks.exportPublicationSuperseded).toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("gives a repaired illustrated page a new revision and retires its generated picture, queueing none itself", async () => {
    // The early-picture keeper rule: the keeper token covers the revision, so the picture drawn from the
    // draft no longer matches this page, and the compile's finalization draws the repaired one.
    strategy.shouldIllustratePage.mockReturnValue(true);
    const original = page({ imagePrompt: "The old scene." });
    mocks.prisma.imageAsset.findMany.mockResolvedValue([
      { id: "generated-same-owner", path: "/assets/images/project-1/page-1.webp", metadata: { legacyGeneratedPageId: "page-1" } },
      { id: "manual-operation", path: "/assets/images/project-1/page-1-edit-operation.webp", metadata: { operationId: "edit-operation" } }
    ]);

    await repairPagesFromFinalQa(repairOptions(original, { deferIllustrations: true }));

    expect(mocks.prisma.page.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "page-1" },
      data: expect.objectContaining({ markdown: "Repaired prose.", revision: { increment: 1 } }) }));
    expect(mocks.prisma.imageAsset.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["generated-same-owner"] } }) }));
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
    expect(mocks.dispatchWorkerGenerationJob).not.toHaveBeenCalled();
  });

  it("refuses an illustrated page unless the compile's finalization will redraw its picture", async () => {
    strategy.shouldIllustratePage.mockReturnValue(true);
    const unavailable = vi.fn();

    await expect(repairPagesFromFinalQa(repairOptions(page({ imagePrompt: "The old scene." }), {
      deferIllustrations: false, onRepairPageUnavailable: unavailable }))).resolves.toBeUndefined();

    expect(mocks.repairQuickDraftPages).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledWith("page-1", 1, expect.objectContaining({
      message: expect.stringContaining("deferred illustration finalization") }));
  });

  it("does not publish exports while a repaired page's picture is outstanding", async () => {
    mocks.enqueueFinalizationIllustrations.mockResolvedValueOnce({ kind: "ready", pendingJobIds: ["image-job-1"], missingPageIndexes: [] });
    const original = page({ imagePrompt: "The old scene." });
    stageCompile(original);
    mocks.loadPageTextSnapshot.mockResolvedValue([{ index: 1, title: "Page 1", markdown: "Repaired prose.", revision: 2 }]);
    Object.assign(mocks.strategy, { shouldIllustratePage: () => true });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const completion = await compileExport(compileJob({ exportPublicationProjectStatus: "GENERATING" }));
      expect(completion.lifecycleSettlement).toBe("defer-to-successor");
      expect(completion.afterJobCompleted).toEqual(expect.any(Function));
      expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
      await completion.afterJobCompleted?.();
    } finally {
      delete (mocks.strategy as Record<string, unknown>).shouldIllustratePage;
      warning.mockRestore();
    }

    expect(mocks.enqueueFinalizationIllustrations).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1", planId: "plan-1", contentRevision: 4
    }));
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ markdown: "Repaired prose.", revision: { increment: 1 } }) })
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
      { contentRevision: 4, completedPredecessorId: "gj-1" }
    );
  });

  it("stands a compile redelivery down before QA while its committed replacement image job is open", async () => {
    const repairedPage = {
      ...page(),
      markdown: "Repaired prose.",
      imagePrompt: "A repaired scene.",
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
        state: "review_recommended",
        score: 95,
        issues: [
          {
            // A finding the reader is shown, so the reconstruction has a reader claim to keep.
            code: "PROMPT_LEAKAGE",
            severity: "error",
            source: "deterministic",
            message: "Page 1 appears to expose generation instructions or hidden prompt text: “system prompt”.",
            guidance: "Regenerate this page without internal instructions.",
            affectedPageIndexes: [1],
            evidence: [{ pageIndex: 1, excerpt: "system prompt" }]
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
    expect(mocks.reviewQuickDraftManuscript).not.toHaveBeenCalled();
    expect(mocks.repairQuickDraftPages).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith({
      where: { id: "gj-1" },
      data: {
        qualityReport: expect.objectContaining({
          state: "review_recommended",
          issues: [expect.objectContaining({ code: "PROMPT_LEAKAGE", affectedPageIndexes: [1] })]
        })
      }
    });
    expect(reports.get("gj-1")).toEqual(
      expect.objectContaining({
        state: "review_recommended",
        issues: [expect.objectContaining({ code: "PROMPT_LEAKAGE", affectedPageIndexes: [1] })]
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

  it("uses the existing stand-down verdict when the atomic page claim loses", async () => {
    const bookPage = page();
    stageCompile(bookPage, "COMPLETE");
    mocks.loadPageTextSnapshot.mockResolvedValue([{ index: 1, title: bookPage.title, markdown: bookPage.markdown, revision: 1 }]);
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(compileJob())).resolves.toEqual({});
    } finally {
      warning.mockRestore();
    }

    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith({
      where: { id: "gj-1" },
      // The stand-down records the screen's verdict instead of letting the
      // superseded exception reach normal failure settlement.
      data: { qualityReport: expect.objectContaining({ state: "passed" }) }
    });
  });
});
