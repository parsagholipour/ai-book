/**
 * `generate-page`: generated illustration retirement across a failed
 * completion and Bull retry.
 *
 * This is the asset-ownership half of keeper publication. The broader quality
 * loop and publication ordering remain in `generatePage.test.ts`; this suite
 * isolates the transactional replacement case whose simulated durable page,
 * assets, and rollback make it a separate behavioral seam.
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
import { draftNamed, job, mocks, report, resetGeneratePageMocks } from "./testing/generatePageMocks.js";

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

describe("generatePage generated asset retirement", () => {
  beforeEach(() => resetGeneratePageMocks());
  afterEach(() => vi.clearAllMocks());

  it("atomically retires a failed attempt's old generated asset before staging a new retry keeper", async () => {
    const loadedAt = new Date("2026-01-01T00:00:00.000Z");
    let durablePage: Record<string, unknown> = {
      id: "page-1",
      projectId: "project-1",
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
    let assets: Array<{ id: string; path: string; metadata: Record<string, unknown> }> = [
      {
        id: "manual-asset",
        path: "/assets/images/project-1/page-1-op-manual-op.webp",
        metadata: { operationId: "manual-op" }
      }
    ];
    let oldKeeperToken = "";
    let failFirstCompletion = true;
    const retirementIds: string[][] = [];
    mocks.prisma.page.findUnique.mockImplementation(async () => ({ ...durablePage }));
    mocks.prisma.page.updateMany.mockImplementation(async ({ where, data }) => {
      if (!pageWhereMatches(durablePage, where as Record<string, unknown>)) return { count: 0 };
      durablePage = { ...durablePage, ...(data as Record<string, unknown>) };
      return { count: 1 };
    });
    mocks.prisma.$transaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) => {
      let transactionPage = { ...durablePage };
      let transactionAssets = assets.map((asset) => ({ ...asset }));
      const tx = {
        page: {
          updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            if (!pageWhereMatches(transactionPage, where)) return { count: 0 };
            transactionPage = { ...transactionPage, ...data };
            return { count: 1 };
          })
        },
        imageAsset: {
          findMany: vi.fn(async () =>
            transactionAssets.map(({ id, path, metadata }) => ({ id, path, metadata }))
          ),
          deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
            // The production predicate is ownership-scoped. The manual asset
            // deliberately has no keeper token/system path and therefore is
            // outside this simulated delete.
            retirementIds.push(where.id.in);
            const before = transactionAssets.length;
            transactionAssets = transactionAssets.filter((asset) => !where.id.in.includes(asset.id));
            return { count: before - transactionAssets.length };
          })
        },
        continuityNote: {
          createMany: vi.fn(async () => {
            if (failFirstCompletion) {
              failFirstCompletion = false;
              throw new Error("continuity store unavailable");
            }
          })
        },
        chapter: mocks.prisma.chapter
      };
      const result = await run(tx);
      durablePage = transactionPage;
      assets = transactionAssets;
      return result;
    });
    const oldDraft = {
      ...draftNamed("Old keeper"),
      imagePrompt: "An old robin",
      continuityNotes: ["The old keeper planted a clue."]
    };
    const newDraft = {
      ...draftNamed("New keeper"),
      imagePrompt: "A new robin",
      continuityNotes: ["The new keeper plants a different clue."]
    };
    mocks.generatePageDraft.mockResolvedValueOnce(oldDraft).mockResolvedValueOnce(newDraft);
    mocks.reviewPageDraft.mockResolvedValue({ ...report(88), approved: true });
    mocks.strategyOverrides.shouldIllustratePage = () => true;
    mocks.enqueueWorkerJob
      .mockImplementationOnce(async ({ payload }: { payload: Record<string, unknown> }) => {
        oldKeeperToken = payload.keeperToken as string;
        return { id: "old-image-job" };
      })
      .mockResolvedValueOnce(undefined);

    await expect(generatePage(job)).rejects.toThrow("continuity store unavailable");
    expect(durablePage).toMatchObject({ status: "GENERATING", title: "Old keeper" });

    // Deterministic interleaving: the old tokened image publishes after the
    // completion transaction rolls back but before Bull retries the page.
    assets.push({
      id: "old-generated-asset",
      path: `/assets/images/project-1/page-page-1-${oldKeeperToken}.webp`,
      metadata: { keeperToken: oldKeeperToken }
    });
    await generatePage(job);

    expect(durablePage).toMatchObject({ status: "GENERATING", title: "New keeper", imagePrompt: "A new robin" });
    expect(assets).toEqual([
      {
        id: "manual-asset",
        path: "/assets/images/project-1/page-1-op-manual-op.webp",
        metadata: { operationId: "manual-op" }
      }
    ]);
    expect(mocks.enqueueNextPageIfReady).not.toHaveBeenCalled();
    expect(retirementIds.at(-1)).toEqual(["old-generated-asset"]);
  });
});
