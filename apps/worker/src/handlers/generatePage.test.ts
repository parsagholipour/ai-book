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
// Real via the partial mock above: the audited-initial-draft test applies the
// same transform `enrichPageQualityReport` does, not a restatement of it.
import { withStyleAudit } from "@book-maker/core";
import {
  completedPage,
  draftNamed,
  job,
  mocks,
  report,
  resetGeneratePageMocks
} from "./testing/generatePageMocks.js";

describe("generatePage quality loop", () => {
  beforeEach(() => resetGeneratePageMocks());
  afterEach(() => vi.clearAllMocks());

  const productionBeat = (beat: string) => ({
    pageIndex: 1,
    chapterIndex: 1,
    purpose: beat,
    beat,
    requiredContinuity: [] as string[],
    endingPressure: ""
  });

  it("keeps compact mode on initial drafts only, not review or QA revision inputs", async () => {
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
    mocks.revisePageDraft.mockResolvedValue(draftNamed("Second"));
    mocks.reviewPageDraft
      .mockResolvedValueOnce({ ...report(60), checks: { repetitionOk: false } })
      .mockResolvedValueOnce({ ...report(90), approved: true, checks: { repetitionOk: true } });

    await generatePage(job);

    expect(mocks.generatePageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ pageDraftContextMode: "compact" })
    );
    expect(mocks.reviewPageDraft.mock.calls[0]?.[0]).not.toHaveProperty("pageDraftContextMode");
    expect(mocks.revisePageDraft.mock.calls[0]?.[0]).not.toHaveProperty("pageDraftContextMode");
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

  /** Drive the three-candidate fixture into a kept brief repair on candidate 3. */
  const stageKeptBriefRepair = (approved: boolean, imagePrompt?: string) => {
    const originalBeat = productionBeat("Repeat the opening");
    const repairedBeat = productionBeat("Reveal the hidden stair");
    const chapterBrief = {
      chapterIndex: 1,
      title: "The stair",
      summary: "A hidden route opens.",
      continuityFocus: [] as string[],
      pages: [originalBeat]
    };
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-1",
      index: 1,
      chapterId: "chapter-1",
      chapter: { id: "chapter-1", index: 1, productionBrief: chapterBrief },
      status: "PENDING",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      title: "First",
      markdown: "First text.",
      summary: "First summary.",
      imagePrompt: null,
      revision: 1
    });
    mocks.parseChapterBrief.mockImplementation((value?: unknown) => value);
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBrief });
    const draft = (title: string) => ({ ...draftNamed(title), ...(imagePrompt ? { imagePrompt } : {}) });
    mocks.generatePageDraft.mockResolvedValue(draft("First"));
    mocks.revisePageDraft.mockResolvedValueOnce(draft("Second")).mockResolvedValue(draft("Recovered"));
    const blamed = { ...report(20), checks: { repetitionOk: false, progressionOk: true } };
    mocks.reviewPageDraft
      .mockResolvedValueOnce(blamed)
      .mockResolvedValueOnce({ ...blamed, score: 30 })
      .mockResolvedValue({ ...report(70), approved, checks: { repetitionOk: true, progressionOk: true } });
    mocks.repairPageBrief.mockResolvedValue(repairedBeat);
    return { chapterBrief, repairedBeat };
  };

  it("saves the highest-scoring draft when no rewrite is approved, not the last one", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.revisePageDraft
      .mockResolvedValueOnce(draftNamed("Second"))
      .mockResolvedValueOnce(draftNamed("Third"));
    // Scores 40 → 70 → 55: the sixth-rewrite-worse-than-second shape in miniature.
    mocks.reviewPageDraft
      .mockResolvedValueOnce(report(40))
      .mockResolvedValueOnce(report(70))
      .mockResolvedValueOnce(report(55));

    await generatePage(job);

    const failedSave = mocks.prisma.page.updateMany.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.status === "FAILED_QA");
    expect(failedSave).toMatchObject({
      title: "Second",
      markdown: "Second text.",
      revision: 2
    });
    expect((failedSave!.qualityReport as { score: number }).score).toBe(70);
    expect(mocks.enqueueNextPageIfReady).toHaveBeenCalledWith("project-1", "plan-1", expect.anything());
  });

  it("keeps a style-audited initial draft over an unaudited rejected rewrite that scores lower", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.revisePageDraft
      .mockResolvedValueOnce(draftNamed("Second"))
      .mockResolvedValueOnce(draftNamed("Third"));
    // The reproduction: the initial draft reviews at 80 and the style audit
    // flags two issues; both rewrites are rejected by the reviewer, so they
    // are never audited. A penalty folded into `score` (80 → 50) made the
    // worse rewrite at 60 the keeper.
    mocks.reviewPageDraft
      .mockResolvedValueOnce(
        withStyleAudit(
          { ...report(80), checks: { styleNatural: true } },
          { styleOk: false, styleIssues: ["Register drifts.", "Rhythm ignored."] }
        )
      )
      .mockResolvedValueOnce(report(60))
      .mockResolvedValueOnce(report(55));

    await generatePage(job);

    const failedSave = mocks.prisma.page.updateMany.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.status === "FAILED_QA");
    expect(failedSave).toMatchObject({ title: "First", revision: 1 });
    const savedReport = failedSave!.qualityReport as { score: number; stylePenalty?: number };
    expect(savedReport.score).toBe(80);
    expect(savedReport.stylePenalty).toBe(30);
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

  it("keeps one failing model review as FAILED_QA when page rewrites are off", async () => {
    mocks.pageQualityEnabled.mockImplementation((feature?: string) => feature === "pageModelReview");
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValue(report(40));

    await generatePage(job);

    expect(mocks.reviewPageDraft).toHaveBeenCalledTimes(1);
    expect(mocks.reviewPageDraft).toHaveBeenCalledWith(expect.objectContaining({ skipLocalChecks: true }));
    expect(mocks.revisePageDraft).not.toHaveBeenCalled();
    expect(
      mocks.prisma.page.updateMany.mock.calls.some(
        (call) => (call[0] as { data: { status?: string } }).data.status === "FAILED_QA"
      )
    ).toBe(true);
  });

  it("rolls the keeper stage back when its kept brief CAS fails", async () => {
    // The page update runs first on the transaction client. A database failure
    // in the chapter CAS must reject the transaction rather than leave that
    // terminal page durable without the assignment it was written against.
    const { chapterBrief } = stageKeptBriefRepair(true);
    const briefFailure = new Error("chapter CAS unavailable");
    let durablePage: Record<string, unknown> | null = null;
    let stagedPage: Record<string, unknown> | null = null;
    const tx = {
      page: {
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          stagedPage = data;
          return { count: 1 };
        })
      },
      imageAsset: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
      chapter: {
        findUnique: vi.fn().mockResolvedValue({ productionBrief: chapterBrief }),
        updateMany: vi.fn().mockRejectedValue(briefFailure)
      }
    };
    mocks.prisma.$transaction.mockImplementationOnce(async (run: (client: typeof tx) => Promise<unknown>) => {
      const result = await run(tx);
      durablePage = stagedPage;
      return result;
    });

    await expect(generatePage(job)).rejects.toBe(briefFailure);

    expect(tx.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "GENERATING" }) })
    );
    expect(tx.chapter.updateMany).toHaveBeenCalledTimes(1);
    expect(durablePage).toBeNull();
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(
      mocks.prisma.page.updateMany.mock.calls.some(
        (call) => (call[0] as { data: { status?: string } }).data.status === "COMPLETED"
      )
    ).toBe(false);
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    expect(mocks.enqueueNextPageIfReady).not.toHaveBeenCalled();
  });

  it("rolls the keeper stage back when every kept-brief CAS loses a race", async () => {
    const { chapterBrief } = stageKeptBriefRepair(true);
    const movingBrief = (label: string) => ({ ...chapterBrief, continuityFocus: [label] });
    let durablePage: Record<string, unknown> | null = null;
    let stagedPage: Record<string, unknown> | null = null;
    const tx = {
      page: {
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          stagedPage = data;
          return { count: 1 };
        })
      },
      imageAsset: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
      chapter: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling A") })
          .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling B") })
          .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling C") }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 })
      }
    };
    mocks.prisma.$transaction.mockImplementationOnce(async (run: (client: typeof tx) => Promise<unknown>) => {
      const result = await run(tx);
      durablePage = stagedPage;
      return result;
    });

    await expect(generatePage(job)).rejects.toMatchObject({
      name: "ChapterBriefPublicationRejectedError",
      chapterId: "chapter-1",
      outcome: "lost-race"
    });

    expect(tx.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "GENERATING" }) })
    );
    expect(tx.chapter.updateMany).toHaveBeenCalledTimes(3);
    expect(durablePage).toBeNull();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.enqueueNextPageIfReady).not.toHaveBeenCalled();
  });

  it("never attempts the kept brief CAS when the FAILED_QA page write fails", async () => {
    // The reverse failure ordering: the page write is the transaction's first
    // statement, so its rejection leaves the chapter completely untouched.
    stageKeptBriefRepair(false);
    const pageFailure = new Error("page update unavailable");
    const tx = {
      page: { updateMany: vi.fn().mockRejectedValue(pageFailure) },
      imageAsset: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
      chapter: { findUnique: vi.fn(), updateMany: vi.fn() }
    };
    mocks.prisma.$transaction.mockImplementationOnce(
      async (run: (client: typeof tx) => Promise<unknown>) => run(tx)
    );

    await expect(generatePage(job)).rejects.toBe(pageFailure);

    expect(tx.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED_QA" }) })
    );
    expect(tx.chapter.findUnique).not.toHaveBeenCalled();
    expect(tx.chapter.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(
      mocks.prisma.page.updateMany.mock.calls.some(
        (call) => (call[0] as { data: { status?: string } }).data.status === "FAILED_QA"
      )
    ).toBe(false);
    expect(mocks.prisma.chapter.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    expect(mocks.enqueueNextPageIfReady).not.toHaveBeenCalled();
  });

  it("does not queue an illustration when its kept brief CAS fails", async () => {
    mocks.strategyOverrides.shouldIllustratePage = () => true;
    const { chapterBrief } = stageKeptBriefRepair(true, "A hidden stair below the floorboards");
    const briefFailure = new Error("chapter CAS unavailable");
    const tx = {
      page: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      imageAsset: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
      chapter: {
        findUnique: vi.fn().mockResolvedValue({ productionBrief: chapterBrief }),
        updateMany: vi.fn().mockRejectedValue(briefFailure)
      }
    };
    mocks.prisma.$transaction.mockImplementationOnce(
      async (run: (client: typeof tx) => Promise<unknown>) => run(tx)
    );

    await expect(generatePage(job)).rejects.toBe(briefFailure);

    expect(tx.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "GENERATING" }) })
    );
    expect(tx.chapter.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(
      mocks.prisma.page.updateMany.mock.calls.some(
        (call) => (call[0] as { data: { status?: string } }).data.status === "COMPLETED"
      )
    ).toBe(false);
    expect(mocks.enqueueNextPageIfReady).not.toHaveBeenCalled();
  });

  it("publishes an illustrated repaired keeper before enqueue and finalizes it with a status-only CAS", async () => {
    mocks.strategyOverrides.shouldIllustratePage = () => true;
    stageKeptBriefRepair(true, "A hidden stair below the floorboards");
    const callOrder: string[] = [];
    mocks.prisma.page.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.status === "GENERATING" && data.title === "Recovered") {
        callOrder.push("stage-keeper");
      } else if (data.status === "COMPLETED") {
        callOrder.push("complete-page");
      }
      return { count: 1 };
    });
    mocks.prisma.chapter.updateMany.mockImplementation(async () => {
      callOrder.push("publish-brief");
      return { count: 1 };
    });
    mocks.enqueueWorkerJob.mockImplementation(async () => {
      callOrder.push("enqueue-image");
      return { id: "image-job" };
    });
    await generatePage(job);

    expect(callOrder).toEqual(["stage-keeper", "publish-brief", "enqueue-image", "complete-page"]);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ keeperToken: expect.any(String) }),
        dedupeKey: expect.stringMatching(/^generate-image:page-1:plan-1:3:v2-[0-9a-f]{24}$/)
      })
    );
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "page-1",
        status: "GENERATING",
        title: "Recovered",
        imagePrompt: "A hidden stair below the floorboards",
        revision: 3
      }),
      data: expect.objectContaining({ status: "COMPLETED" })
    });
  });

  it("retries when a stable page is reindexed after its keeper is staged", async () => {
    mocks.strategyOverrides.shouldIllustratePage = () => true;
    stageKeptBriefRepair(true, "A hidden stair below the floorboards");
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
    stageKeptBriefRepair(true, "A hidden stair below the floorboards");
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

  it("does not best-of sequential drafts when quality bestOfPolish is off even if draftCandidates is 2", async () => {
    // Page 2, not the fixture's page 1: the first page best-ofs by tier on its
    // own, and this test is about the operator draftCandidates gate.
    mocks.prisma.page.findUnique.mockResolvedValue({ id: "page-1", index: 2, chapterId: null, chapter: null });
    mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: { draftCandidates: 2 } });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.generateBestOfPageDrafts).not.toHaveBeenCalled();
    expect(mocks.generatePageDraft).toHaveBeenCalled();
  });

  it("best-ofs page 1 by the tier gate alone when the operator gate is off", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValue({ ...report(88), approved: true });

    await generatePage(job);

    // bestOfPolish is off, so this 2 is the balanced tier's first-page gate alone.
    expect(mocks.generateBestOfPageDrafts).toHaveBeenCalledWith(expect.objectContaining({ candidateCount: 2 }));
  });

  it("takes the larger of the tier and operator gates on page 1", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValue({ ...report(88), approved: true });

    // Operator gate on and higher: `Math.max` takes its 3, never the tier's 2 and never 6.
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "bestOfPolish");
    mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: { draftCandidates: 3 } });
    await generatePage(job);

    expect(mocks.generateBestOfPageDrafts).toHaveBeenLastCalledWith(expect.objectContaining({ candidateCount: 3 }));
  });

  it("best-ofs sequential drafts when bestOfPolish is on and draftCandidates is 2", async () => {
    // Page 2 again: on page 1 the tier gate alone answers 2, so this count
    // would prove nothing about the operator gate this test is named for.
    mocks.prisma.page.findUnique.mockResolvedValue({ id: "page-1", index: 2, chapterId: null, chapter: null });
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "bestOfPolish");
    mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: { draftCandidates: 2 } });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.generateBestOfPageDrafts).toHaveBeenCalledWith(expect.objectContaining({ candidateCount: 2 }));
    expect(mocks.generatePageDraft).toHaveBeenCalled();
  });

  /** A page whose recency window already carries the book's opening pages. */
  const withStyleLock = () => {
    mocks.prisma.page.findUnique.mockResolvedValue({ id: "page-5", index: 5, chapterId: null, chapter: null });
    mocks.prisma.page.findMany.mockResolvedValue([
      completedPage(1, "opening-voice"),
      completedPage(2, "second-voice"),
      completedPage(3, "third"),
      completedPage(4, "fourth")
    ]);
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.revisePageDraft.mockResolvedValue(draftNamed("Second"));
  };

  /** The quality report the page was finally saved on. */
  const savedQualityReport = () =>
    mocks.prisma.page.updateMany.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.qualityReport)!.qualityReport as Record<
      string,
      unknown
    >;

  it("audits an approved rewrite against the same pin the draft was written from", async () => {
    mocks.qualityEnabled.mockImplementation(
      (feature?: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    withStyleLock();
    mocks.reviewPageDraft.mockResolvedValueOnce(report(50)).mockResolvedValue({ ...report(88), approved: true });

    await generatePage(job);

    // One pin, three readers: the draft, the enrichment pass whose answer the
    // auditor is built out of, and the audit itself. Asserted by reference, so
    // deriving the auditor's excerpts a second way fails here.
    const pinned = (mocks.generatePageDraft.mock.calls[0]![0] as { styleExcerpts: string[] }).styleExcerpts;
    expect(pinned).toHaveLength(2);
    expect(
      (mocks.enrichPageQualityReport.mock.calls[0]![0] as { styleExcerpts?: string[] }).styleExcerpts
    ).toBe(pinned);
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(1);
    const audited = mocks.auditPageStyle.mock.calls[0]![0] as { markdown: string; styleExcerpts: string[] };
    expect(audited.markdown).toBe("Second text.");
    expect(audited.styleExcerpts).toBe(pinned);
    // Zero rather than absent: it is what marks the report as audited at all.
    expect(savedQualityReport().stylePenalty).toBe(0);
  });

  it("builds no auditor with the gate off, or with nothing pinned to compare against", async () => {
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "styleExcerpts");
    withStyleLock();
    mocks.reviewPageDraft.mockResolvedValueOnce(report(50)).mockResolvedValue({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
    expect(savedQualityReport()).not.toHaveProperty("stylePenalty");

    // Auditor gate on, excerpts gate off: nothing is pinned to audit against.
    vi.clearAllMocks();
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "styleAuditor");
    withStyleLock();
    mocks.reviewPageDraft.mockResolvedValueOnce(report(50)).mockResolvedValue({ ...report(88), approved: true });
    await generatePage(job);

    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
  });

  it("carries a failed audit's penalty and issues into the report it saves", async () => {
    mocks.qualityEnabled.mockImplementation(
      (feature?: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    withStyleLock();
    mocks.reviewPageDraft.mockResolvedValueOnce(report(50)).mockResolvedValue({ ...report(88), approved: true });
    mocks.auditPageStyle.mockResolvedValue({
      styleOk: false,
      styleIssues: ["Register drifts into lecture mode.", "Rhythm ignores the opening."]
    });

    await generatePage(job);

    // The reviewer approved both rewrites and the audit rejected both, so the
    // page is saved flagged on the audited report rather than shipping.
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(2);
    expect(savedQualityReport()).toMatchObject({ score: 88, stylePenalty: 30 });
    expect(savedQualityReport().issues).toContain("Register drifts into lecture mode.");
  });
});
