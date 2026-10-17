/**
 * `generate-page`: what becomes of the draft.
 *
 * Everything from the candidate-count decision onwards — how many drafts the
 * two best-of gates ask for, which of the review loop's candidates is kept and
 * on what report, what the style audit does to that report, and the save that
 * follows it: the FAILED_QA and COMPLETED writes, the continuity notes, the
 * illustration enqueued strictly before the page goes terminal, and the fan-out
 * to the next page.
 *
 * The other half — the context the page is drafted *from* — is
 * `generatePageContext.test.ts`. Both suites stand the same modules up through
 * `testing/generatePageMocks.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/generatePageMocks.js")).dbModuleMock());
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/generatePageMocks.js")).dispatchModuleMock());
vi.mock(
  "../runtime/jobLifecycle.js",
  async () => (await import("./testing/generatePageMocks.js")).jobLifecycleModuleMock()
);
vi.mock("../runtime/config.js", async () => (await import("./testing/generatePageMocks.js")).configModuleMock());
vi.mock(
  "../providers/loggedAdapters.js",
  async () => (await import("./testing/generatePageMocks.js")).loggedAdaptersModuleMock()
);
vi.mock(
  "../generation/embeddingRepair.js",
  async () => (await import("./testing/generatePageMocks.js")).embeddingRepairModuleMock()
);
vi.mock(
  "../generation/embeddingWrites.js",
  async () => (await import("./testing/generatePageMocks.js")).embeddingWritesModuleMock()
);
vi.mock(
  "../generation/entityState.js",
  async () => (await import("./testing/generatePageMocks.js")).entityStateModuleMock()
);
vi.mock(
  "../generation/researchMemory.js",
  async () => (await import("./testing/generatePageMocks.js")).researchMemoryModuleMock()
);
vi.mock(
  "../generation/semanticRecall.js",
  async () => (await import("./testing/generatePageMocks.js")).semanticRecallModuleMock()
);
vi.mock(
  "../generation/generationContext.js",
  async () => (await import("./testing/generatePageMocks.js")).generationContextModuleMock()
);
vi.mock(
  "../generation/projectInput.js",
  async () => (await import("./testing/generatePageMocks.js")).projectInputModuleMock()
);
vi.mock("../generation/bookHelpers.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/bookHelpers.js")>(
    "../generation/bookHelpers.js"
  );
  return (await import("./testing/generatePageMocks.js")).bookHelpersModuleMock(actual);
});
vi.mock("../generation/tuning.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/tuning.js")>("../generation/tuning.js");
  return (await import("./testing/generatePageMocks.js")).tuningModuleMock(actual);
});
vi.mock(
  "../generation/qualitySettings.js",
  async () => (await import("./testing/generatePageMocks.js")).qualitySettingsModuleMock()
);
vi.mock(
  "../generation/storyStateStore.js",
  async () => (await import("./testing/generatePageMocks.js")).storyStateStoreModuleMock()
);
vi.mock("../generation/pageQualityGateReview.js", async () =>
  (await import("./testing/generatePageMocks.js")).pageQualityGateReviewModuleMock(
    await vi.importActual<typeof import("../generation/pageQualityGateReview.js")>("../generation/pageQualityGateReview.js")
  )
);
vi.mock("../generation/qualityEnrichment.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/qualityEnrichment.js")>(
    "../generation/qualityEnrichment.js"
  );
  return (await import("./testing/generatePageMocks.js")).qualityEnrichmentModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/generatePageMocks.js")).coreModuleMock(actual);
});

import { generatePage } from "./generatePage.js";
import { ownsPageIllustration } from "../generation/pageIllustrationOwnership.js";
import { GeneratedPagePublicationClaimLostError } from "../generation/pagePublication.js";
import type { QualityFeatureId } from "@book-maker/core/qualityGates";
import {
  draftNamed,
  job,
  mocks,
  report,
  resetGeneratePageMocks
} from "./testing/generatePageMocks.js";

describe("generatePage quality loop", () => {
  beforeEach(() => resetGeneratePageMocks());
  afterEach(() => vi.clearAllMocks());

  it("keeps compact mode on the draft only, not on the page's checks", async () => {
    const baseline = (await mocks.loadQualityContext()) as {
      enabled: (feature: QualityFeatureId) => boolean;
    };
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "ultra",
      enabled: (feature: QualityFeatureId) =>
        feature === "compactPageDraftContext" ? true : baseline.enabled(feature)
    });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPage.mockResolvedValueOnce({ ...report(90), approved: true });

    await generatePage(job);

    expect(mocks.generatePageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ pageDraftContextMode: "compact" })
    );
    expect((mocks.reviewPage.mock.calls[0]![0] as { reviewOptions: object }).reviewOptions).not.toHaveProperty("pageDraftContextMode");
  });

  const pageWhereMatches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([field, expected]) => {
      if (field === "status" && expected && typeof expected === "object" && "not" in expected) {
        return row.status !== (expected as { not: unknown }).not;
      }
      const actual = row[field];
      return actual instanceof Date && expected instanceof Date
        ? actual.getTime() === expected.getTime()
        : actual === expected;
    });

  it("saves an approved draft as-is", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    const completedSave = mocks.prisma.page.updateMany.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.title === "First" && data.qualityReport);
    expect(completedSave).toMatchObject({ title: "First", revision: 1 });
    expect(mocks.revisePageDraft).not.toHaveBeenCalled();
  });

  it("skips configurable page review and its progress copy when all pipeline QA gates are off", async () => {
    mocks.pageQualityEnabled.mockReturnValue(false);
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPage.mockResolvedValueOnce({ ...report(100), approved: true });

    await generatePage(job);

    expect(mocks.reviewPageDraft).not.toHaveBeenCalled();
    expect(mocks.revisePageDraft).not.toHaveBeenCalled();
    expect(mocks.advanceJobStep.mock.calls.some((call) => String(call[3]).includes("Reviewing page"))).toBe(false);
    expect(
      mocks.prisma.page.updateMany.mock.calls.some(
        (call) => (call[0] as { data: { status?: string } }).data.status === "COMPLETED"
      )
    ).toBe(true);
  });

  it("saves a draft its local checks fail as FAILED_QA, and no model reviews or rewrites it", async () => {
    // Every gate on: the page review gates still reach no generated page (E5).
    mocks.pageQualityEnabled.mockReturnValue(true);
    mocks.qualityEnabled.mockReturnValue(true);
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPage.mockResolvedValueOnce(report(40));

    await generatePage(job);

    const gates = (mocks.reviewPage.mock.calls[0]![0] as unknown as { quality: { enabled: (feature: string) => boolean } }).quality;
    for (const feature of ["pageModelReview", "pageQaRewrite", "smartUnslop", "styleAuditor"]) {
      expect(gates.enabled(feature), feature).toBe(false);
    }
    expect(gates.enabled("pageLocalQa")).toBe(true);
    expect(mocks.reviewPageDraft).not.toHaveBeenCalled();
    expect(mocks.revisePageDraft).not.toHaveBeenCalled();
    expect(
      mocks.prisma.page.updateMany.mock.calls.some(
        (call) => (call[0] as { data: { status?: string } }).data.status === "FAILED_QA"
      )
    ).toBe(true);
  });

  it("retries when a stable page is reindexed after its keeper is staged", async () => {
    mocks.strategyOverrides.shouldIllustratePage = () => true;
    mocks.generatePageDraft.mockResolvedValue({ ...draftNamed("First"), imagePrompt: "A hidden stair below the floorboards" });
    mocks.reviewPage.mockResolvedValueOnce({ ...report(88), approved: true });
    let currentPageIndex = 1;
    mocks.prisma.page.updateMany.mockImplementation(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
        count: data.status === "COMPLETED" && where.index !== currentPageIndex ? 0 : 1
      })
    );
    mocks.enqueueWorkerJob.mockImplementationOnce(async () => {
      // Structural ordering keeps updatedAt stable, so only the index predicate
      // tells the completion claim that this page moved after staging.
      currentPageIndex = 2;
      return { id: "image-job" };
    });

    await expect(generatePage(job)).rejects.toBeInstanceOf(GeneratedPagePublicationClaimLostError);

    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    expect(mocks.storeEmbedding).not.toHaveBeenCalled();
    expect(mocks.enqueueNextPageIfReady).not.toHaveBeenCalled();
  });

  it("cannot let a stalled delivery overwrite a newer finalized keeper", async () => {
    const loadedAt = new Date("2026-01-01T00:00:00.000Z");
    let durablePage: Record<string, unknown> = {
      id: "page-1",
      index: 1,
      chapterId: null,
      chapter: null,
      status: "PENDING",
      updatedAt: loadedAt,
      title: "Old placeholder",
      markdown: "",
      summary: "",
      imagePrompt: null,
      revision: 1
    };
    mocks.prisma.page.findUnique.mockImplementation(async () => ({ ...durablePage }));
    mocks.prisma.page.updateMany.mockImplementation(async ({ where, data }) => {
      if (!pageWhereMatches(durablePage, where as Record<string, unknown>)) return { count: 0 };
      durablePage = { ...durablePage, ...(data as Record<string, unknown>) };
      return { count: 1 };
    });
    mocks.generatePageDraft.mockResolvedValue({ ...draftNamed("Old delivery"), imagePrompt: "Old prompt" });
    mocks.strategyOverrides.shouldIllustratePage = () => true;
    mocks.reviewPageDraft.mockImplementationOnce(async () => {
      // Deterministic interleaving: after the old delivery claimed its loaded
      // version, a newer delivery publishes a different terminal keeper.
      durablePage = {
        ...durablePage,
        status: "COMPLETED",
        updatedAt: new Date((durablePage.updatedAt as Date).getTime() + 10),
        title: "Newer keeper",
        markdown: "Newer text.",
        summary: "Newer summary.",
        imagePrompt: "New prompt"
      };
      return { ...report(88), approved: true };
    });

    await generatePage(job);

    expect(durablePage).toMatchObject({
      status: "COMPLETED",
      title: "Newer keeper",
      markdown: "Newer text.",
      imagePrompt: "New prompt"
    });
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.enqueueNextPageIfReady).not.toHaveBeenCalled();
  });

  it("does not expose COMPLETED when project ownership declines the image job", async () => {
    mocks.strategyOverrides.shouldIllustratePage = () => true;
    mocks.generatePageDraft.mockResolvedValue({ ...draftNamed("First"), imagePrompt: "A hidden stair below the floorboards" });
    mocks.reviewPage.mockResolvedValueOnce({ ...report(88), approved: true });
    mocks.enqueueWorkerJob.mockResolvedValueOnce(undefined);

    await generatePage(job);

    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
    expect(
      mocks.prisma.page.updateMany.mock.calls.some(
        (call) => (call[0] as { data: { status?: string } }).data.status === "COMPLETED"
      )
    ).toBe(false);
    expect(mocks.enqueueNextPageIfReady).not.toHaveBeenCalled();
  });

  it("replays only next-page fan-out when enqueue fails after COMPLETED", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });
    const enqueueFailure = new Error("queue unavailable");
    mocks.enqueueNextPageIfReady.mockRejectedValueOnce(enqueueFailure).mockResolvedValueOnce(undefined);

    await expect(generatePage(job)).rejects.toBe(enqueueFailure);

    expect(
      mocks.prisma.page.updateMany.mock.calls.some(
        (call) => (call[0] as { data: { status?: string } }).data.status === "COMPLETED"
      )
    ).toBe(true);
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-1",
      index: 1,
      chapterId: null,
      chapter: null,
      status: "COMPLETED",
      updatedAt: new Date("2026-01-01T00:00:01.000Z")
    });

    await expect(generatePage(job)).resolves.toBeUndefined();

    expect(mocks.enqueueNextPageIfReady).toHaveBeenCalledTimes(2);
    expect(mocks.generatePageDraft).toHaveBeenCalledTimes(1);
    expect(mocks.reviewPageDraft).toHaveBeenCalledTimes(1);
  });

  it("rolls back completion with continuity notes and retries from GENERATING", async () => {
    mocks.generatePageDraft.mockResolvedValue({
      ...draftNamed("First"),
      continuityNotes: ["Pip keeps the brass key."]
    });
    mocks.reviewPageDraft.mockResolvedValue({ ...report(88), approved: true });
    const noteFailure = new Error("continuity store unavailable");
    const tx = {
      page: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      continuityNote: { createMany: vi.fn().mockRejectedValue(noteFailure) }
    };
    mocks.prisma.$transaction.mockImplementationOnce(
      async (run: (client: typeof tx) => Promise<unknown>) => run(tx)
    );

    await expect(generatePage(job)).rejects.toBe(noteFailure);

    expect(tx.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    expect(mocks.enqueueNextPageIfReady).not.toHaveBeenCalled();

    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-1",
      index: 1,
      chapterId: null,
      chapter: null,
      status: "GENERATING",
      updatedAt: new Date("2026-01-01T00:00:01.000Z")
    });
    await expect(generatePage(job)).resolves.toBeUndefined();

    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueNextPageIfReady).toHaveBeenCalledTimes(1);
  });

  it("owns new continuity notes by the stable page id", async () => {
    mocks.generatePageDraft.mockResolvedValue({
      ...draftNamed("First"),
      continuityNotes: ["Pip keeps the brass key."]
    });
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ pageId: "page-1", scope: "page:1", body: "Pip keeps the brass key." })]
    });
  });

  it("queues the illustration before saving the page as COMPLETED", async () => {
    // A sibling page's maybeEnqueueCompile call must never observe this page
    // as terminal with no open image job behind it — the image job has to
    // exist strictly before the COMPLETED write lands.
    mocks.strategyOverrides.shouldIllustratePage = () => true;
    const loadedAt = new Date("2026-01-01T00:00:00.000Z");
    let durablePage: Record<string, unknown> = {
      id: "page-1",
      index: 1,
      chapterId: null,
      chapter: null,
      status: "PENDING",
      updatedAt: loadedAt,
      title: "Placeholder",
      markdown: "",
      summary: "",
      imagePrompt: null,
      revision: 1
    };
    mocks.prisma.page.findUnique.mockImplementation(async () => ({ ...durablePage }));
    mocks.generatePageDraft.mockResolvedValue({ ...draftNamed("First"), imagePrompt: "A robin on a branch" });
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });
    const callOrder: string[] = [];
    mocks.enqueueWorkerJob.mockImplementation(async ({ payload }: { payload: Record<string, unknown> }) => {
      expect(
        ownsPageIllustration(
          {
            ...(durablePage as Omit<Parameters<typeof ownsPageIllustration>[0], "projectId" | "pageId">),
            projectId: "project-1",
            pageId: "page-1"
          },
          payload.keeperToken as string
        )
      ).toBe(true);
      callOrder.push("enqueue-image");
      return { id: "image-job" };
    });
    mocks.prisma.page.updateMany.mockImplementation(async ({ where, data }) => {
      if (!pageWhereMatches(durablePage, where as Record<string, unknown>)) return { count: 0 };
      if (data.status === "GENERATING" && data.title === "First") {
        callOrder.push("stage-keeper");
      } else if (data.status === "COMPLETED") {
        callOrder.push("save-completed");
      }
      durablePage = { ...durablePage, ...(data as Record<string, unknown>) };
      return { count: 1 };
    });

    await generatePage(job);

    expect(callOrder).toEqual(["stage-keeper", "enqueue-image", "save-completed"]);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "GENERATE_IMAGE",
        payload: expect.objectContaining({
          pageId: "page-1",
          planId: "plan-1",
          prompt: "A robin on a branch",
          keeperToken: expect.any(String)
        })
      })
    );
  });

  it("does not enqueue an illustration for a page the strategy won't illustrate", async () => {
    mocks.strategyOverrides.shouldIllustratePage = () => false;
    mocks.generatePageDraft.mockResolvedValue({ ...draftNamed("First"), imagePrompt: "A robin on a branch" });
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  });

  it("drafts every page once, page 1 included, whatever draftCandidates and the stored gates say", async () => {
    // Best-of drafting was removed on 2026-10-16 (E4): a stored revision that still
    // lists the retired gate, and a book asking for three candidates, get one draft.
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "bestOfPolish");
    mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: { draftCandidates: 3 } });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValue({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.generatePageDraft).toHaveBeenCalledTimes(1);
  });

});
