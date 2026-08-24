import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageQualityReport } from "@book-maker/core";

/** The durable GENERATING -> image job -> exact keeper completion protocol. */
const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    page: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    imageAsset: { findMany: vi.fn(), deleteMany: vi.fn(), update: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    chapter: { findUnique: vi.fn(), updateMany: vi.fn() }
  },
  enqueueWorkerJob: vi.fn(),
  keeperStoryExtractForSave: vi.fn(),
  persistStoryExtract: vi.fn(),
  prepareEmbedding: vi.fn(),
  writePreparedEmbedding: vi.fn(),
  updateEntityStateFromPage: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: vi.fn() }));
vi.mock("./generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({ settings: {}, tier: "balanced", enabled: () => false }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("./qualityEnrichment.js", () => ({
  enrichPageQualityReport: async ({ report }: { report: PageQualityReport }) => ({
    report,
    extract: null,
    storyState: { promises: [], facts: [], entities: {}, unanswered: [] }
  }),
  keeperStoryExtractForSave: mocks.keeperStoryExtractForSave,
  persistStoryExtract: mocks.persistStoryExtract,
  revisedDraftStyleAuditor: () => undefined
}));
vi.mock("./embeddingWrites.js", () => ({
  strategyUsesSemanticMemory: () => true,
  prepareEmbedding: mocks.prepareEmbedding,
  writePreparedEmbedding: mocks.writePreparedEmbedding
}));
vi.mock("./entityState.js", () => ({ updateEntityStateFromPage: mocks.updateEntityStateFromPage }));
vi.mock("./researchMemory.js", () => ({ retrieveSemanticResearchNotes: async () => [] }));
vi.mock("./bookHelpers.js", () => ({
  formatQualityFailure: () => "quality failure detail",
  styleExcerptsForPage: async () => []
}));

import {
  GeneratedPagePublicationClaimLostError,
  stageGeneratedPageWithClient
} from "./pagePublication.js";
import { pageIllustrationKeeperTokens } from "./pageIllustrationOwnership.js";
import { reviewAndSaveGeneratedPage } from "./pageReview.js";
import {
  LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY,
  isLegacyGeneratedPageIllustrationPath,
  stampLegacyGeneratedIllustrationOwnership
} from "@book-maker/db/pageIllustrationOwnership";

const approvedReport = {
  approved: true,
  score: 90,
  issues: [],
  requiredRevisions: [],
  notes: "",
  checks: { repetitionOk: true, progressionOk: true }
} as unknown as PageQualityReport;

const strategy = {
  id: "test-strategy",
  executionMode: "sequential-pages",
  reviewPageDraft: vi.fn(),
  revisePageDraft: vi.fn(),
  repairPageBrief: vi.fn(),
  shouldIllustratePage: vi.fn()
};

const baseOptions = (imagePrompt?: string, continuityNotes: string[] = []) =>
  ({
    projectId: "project-1",
    planId: "plan-1",
    input: { mediaSettings: {} },
    plan: { title: "Book", chapters: [] },
    providers: { text: {}, embedding: {} },
    strategy,
    draft: {
      index: 3,
      title: "First",
      markdown: "First text.",
      summary: "First summary.",
      continuityNotes,
      ...(imagePrompt ? { imagePrompt } : {})
    },
    chapterId: null,
    previousPages: []
  }) as unknown as Parameters<typeof reviewAndSaveGeneratedPage>[0];

describe("reviewAndSaveGeneratedPage illustration publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma)
    );
    mocks.prisma.page.findUnique.mockResolvedValue(null);
    mocks.prisma.page.create.mockResolvedValue({ id: "page-row-1" });
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.imageAsset.findMany.mockResolvedValue([]);
    mocks.enqueueWorkerJob.mockResolvedValue({ id: "image-job" });
    mocks.keeperStoryExtractForSave.mockResolvedValue({ storyDelta: { facts: ["The robin flew."] } });
    mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1,0.2]", error: null });
    strategy.reviewPageDraft.mockResolvedValue(approvedReport);
    strategy.shouldIllustratePage.mockReturnValue(false);
  });

  it("completes a page with no illustration without queueing an image", async () => {
    await reviewAndSaveGeneratedPage(baseOptions());

    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.prisma.page.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "GENERATING", imagePrompt: null })
    });
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
  });

  it("queues a tokened durable image job strictly between staging and completion", async () => {
    strategy.shouldIllustratePage.mockReturnValue(true);
    const order: string[] = [];
    mocks.prisma.page.create.mockImplementationOnce(async () => {
      order.push("stage-keeper");
      return { id: "page-row-1" };
    });
    mocks.enqueueWorkerJob.mockImplementationOnce(async () => {
      order.push("enqueue-image");
      return { id: "image-job" };
    });
    mocks.prisma.page.updateMany.mockImplementationOnce(async () => {
      order.push("complete-page");
      return { count: 1 };
    });

    await reviewAndSaveGeneratedPage(baseOptions("A robin on a branch", ["The robin is named Pip."]));

    expect(order).toEqual(["stage-keeper", "enqueue-image", "complete-page"]);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ keeperToken: expect.any(String) }),
        dedupeKey: expect.stringMatching(/^generate-image:page-row-1:plan-1:1:v2-[0-9a-f]{24}$/)
      })
    );
    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledTimes(1);
  });

  it("leaves the staged keeper non-terminal when durable enqueue is declined", async () => {
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.enqueueWorkerJob.mockResolvedValueOnce(undefined);

    const saved = await reviewAndSaveGeneratedPage(baseOptions("A robin on a branch"));

    expect(saved.page).toEqual(expect.objectContaining({ index: 3, markdown: "First text." }));
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
  });

  it("keeps the staged keeper retryable when image enqueue throws", async () => {
    strategy.shouldIllustratePage.mockReturnValue(true);
    const queueFailure = new Error("generation job store unavailable");
    mocks.enqueueWorkerJob.mockRejectedValueOnce(queueFailure);

    await expect(reviewAndSaveGeneratedPage(baseOptions("A robin on a branch"))).rejects.toBe(queueFailure);

    expect(mocks.prisma.page.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "GENERATING" })
    });
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
  });

  it("fails instead of returning local context when the replacement is not terminal", async () => {
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.prisma.page.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      reviewAndSaveGeneratedPage(baseOptions("A robin on a branch", ["The robin is named Pip."]))
    ).rejects.toBeInstanceOf(GeneratedPagePublicationClaimLostError);

    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "page-row-1",
        status: "GENERATING",
        title: "First",
        markdown: "First text.",
        summary: "First summary.",
        imagePrompt: "A robin on a branch",
        revision: 1,
        updatedAt: expect.any(Date)
      }),
      data: expect.objectContaining({ status: "COMPLETED" })
    });
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
    expect(mocks.updateEntityStateFromPage).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
  });

  it("lets a lease-specific stand-down error win after completion is superseded", async () => {
    strategy.shouldIllustratePage.mockReturnValue(true);
    const leaseLost = new Error("structural lease lost");
    let lost = false;
    mocks.prisma.page.updateMany.mockImplementationOnce(async () => {
      lost = true;
      return { count: 0 };
    });

    await expect(
      reviewAndSaveGeneratedPage({
        ...baseOptions("A robin on a branch"),
        assertOwnership: async () => {
          if (lost) {
            throw leaseLost;
          }
        }
      })
    ).rejects.toBe(leaseLost);

    // Only the initial ownership snapshot was read: the lease verdict stands
    // the delivery down before it can mistake another keeper for its own.
    expect(mocks.prisma.page.findUnique).toHaveBeenCalledTimes(1);
  });

  it("claims an existing pending row by status and optimistic version", async () => {
    const loadedAt = new Date("2026-01-01T00:00:00.000Z");
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-row-1",
      status: "PENDING",
      title: "Placeholder",
      markdown: "",
      summary: "",
      imagePrompt: null,
      revision: 1,
      updatedAt: loadedAt
    });

    await reviewAndSaveGeneratedPage(baseOptions());

    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "page-row-1", status: "PENDING", updatedAt: loadedAt },
      data: { status: "GENERATING", title: "First", revision: 1 }
    });
    expect(mocks.prisma.imageAsset.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.imageAsset.deleteMany).not.toHaveBeenCalled();
  });

  it("uses the shared ownership rules and preserves a manual asset before a replacement image failure", async () => {
    const oldKeeper = {
      title: "Old keeper",
      markdown: "Old text.",
      summary: "Old summary.",
      imagePrompt: "An old robin",
      revision: 1
    };
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-row-1",
      status: "GENERATING",
      ...oldKeeper,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    });
    strategy.shouldIllustratePage.mockReturnValue(true);
    let staleLegacyAssetPresent = true;
    const order: string[] = [];
    const [currentToken, legacyToken] = pageIllustrationKeeperTokens({
      projectId: "project-1",
      pageId: "page-row-1",
      ...oldKeeper
    });
    mocks.prisma.imageAsset.findMany.mockResolvedValueOnce([
      {
        id: "current-token",
        path: "/assets/images/project-1/generated.webp",
        metadata: { keeperToken: currentToken }
      },
      {
        id: "legacy-token",
        path: `/assets/images/project-1/page-page-row-1-${legacyToken}.png`,
        metadata: null
      },
      {
        id: "exact-legacy",
        path: "/assets/images/project-1/page-3.jpg",
        metadata: {}
      },
      {
        id: "manual-operation",
        path: "/assets/images/project-1/page-3-op-7-user-edit.jpg",
        metadata: { operationId: "op-7" }
      }
    ]);
    mocks.prisma.imageAsset.deleteMany.mockImplementationOnce(async () => {
      order.push("retire-old-illustration");
      staleLegacyAssetPresent = false;
      return { count: 1 };
    });
    mocks.enqueueWorkerJob.mockImplementationOnce(async () => {
      order.push("replacement-image-failed");
      return undefined;
    });

    await reviewAndSaveGeneratedPage(baseOptions("A new robin"));

    expect(mocks.prisma.imageAsset.findMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        pageId: "page-row-1",
        type: { in: ["SCENE_ILLUSTRATION", "DIAGRAM"] }
      },
      select: { id: true, path: true, metadata: true }
    });
    expect(mocks.prisma.imageAsset.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["current-token", "legacy-token", "exact-legacy"] },
        projectId: "project-1",
        pageId: "page-row-1"
      }
    });
    expect(order).toEqual(["retire-old-illustration", "replacement-image-failed"]);
    expect(staleLegacyAssetPresent).toBe(false);
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
  });

  it("retires a structurally reindexed legacy render before its replacement can coexist at export", async () => {
    const oldKeeper = {
      title: "Old keeper",
      markdown: "Old text.",
      summary: "Old summary.",
      imagePrompt: "An old robin",
      revision: 1
    };
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-row-1",
      status: "GENERATING",
      ...oldKeeper,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    });
    strategy.shouldIllustratePage.mockReturnValue(true);
    let imageRows = [
      {
        id: "stale-generated",
        projectId: "project-1",
        pageId: "page-row-1",
        type: "SCENE_ILLUSTRATION",
        path: "https://api.example/assets/images/project-1/page-2.png",
        metadata: { [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "page-row-1" }
      },
      {
        id: "other-page",
        projectId: "project-1",
        pageId: "page-row-2",
        type: "SCENE_ILLUSTRATION",
        path: "https://api.example/assets/images/project-1/page-2.png",
        metadata: { [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "page-row-2" }
      }
    ];
    mocks.prisma.imageAsset.findMany.mockImplementationOnce(async () =>
      imageRows
        .filter((asset) => asset.projectId === "project-1" && asset.pageId === "page-row-1")
        .map(({ id, path, metadata }) => ({ id, path, metadata }))
    );
    mocks.prisma.imageAsset.deleteMany.mockImplementationOnce(async ({ where }: { where: Record<string, unknown> }) => {
      const ids = (where.id as { in: string[] }).in;
      imageRows = imageRows.filter(
        (asset) =>
          asset.projectId !== where.projectId ||
          asset.pageId !== where.pageId ||
          !ids.includes(asset.id)
      );
      return { count: 1 };
    });

    await reviewAndSaveGeneratedPage(baseOptions("A new robin"));
    imageRows.push({
      id: "replacement-generated",
      projectId: "project-1",
      pageId: "page-row-1",
      type: "SCENE_ILLUSTRATION",
      path: "https://api.example/assets/images/project-1/page-page-row-1-v2-token.png",
      metadata: { [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "replacement" }
    });

    // `markdownPages` consumes `page.images[0]`; there is no stale generated
    // row left for the relation's unspecified ordering to put before the new
    // keeper. Rows belonging to other pages were outside the retirement scope.
    expect(imageRows.filter((asset) => asset.pageId === "page-row-1").map((asset) => asset.id)).toEqual([
      "replacement-generated"
    ]);
    expect(imageRows.some((asset) => asset.id === "other-page")).toBe(true);
  });

  it("recognizes only the exact legacy system filename for this project and page", () => {
    expect(
      isLegacyGeneratedPageIllustrationPath(
        "https://old-api.example/assets/images/project-1/page-3.png",
        "project-1",
        3
      )
    ).toBe(true);

    // User replacements are operation-suffixed; moved generated heroes keep
    // their source page's index. Neither reserved-path mismatch is retired.
    expect(
      isLegacyGeneratedPageIllustrationPath(
        "https://api.example/assets/images/project-1/page-3-op-7-user-edit.jpg",
        "project-1",
        3
      )
    ).toBe(false);
    expect(
      isLegacyGeneratedPageIllustrationPath(
        "https://api.example/assets/images/project-1/page-2.png",
        "project-1",
        3
      )
    ).toBe(false);
    expect(
      isLegacyGeneratedPageIllustrationPath(
        "https://api.example/assets/images/project-2/page-3.png",
        "project-1",
        3
      )
    ).toBe(false);
  });

  it("resolves every unmarked numeric legacy render against the pre-reindex page snapshot", async () => {
    const update = vi.fn(async () => ({}));

    await stampLegacyGeneratedIllustrationOwnership(
      { imageAsset: { update } } as never,
      "project-1",
      [
        { id: "page-row-1", index: 1, images: [] },
        {
          id: "page-row-2",
          index: 2,
          images: [
            {
              id: "generated-before-reindex",
              type: "SCENE_ILLUSTRATION",
              path: "https://api.example/assets/images/project-1/page-2.png",
              metadata: { model: "legacy-model" }
            },
            {
              id: "already-stamped",
              type: "SCENE_ILLUSTRATION",
              path: "https://api.example/assets/images/project-1/page-2.jpg",
              metadata: { [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "page-row-2" }
            },
            {
              id: "collision-with-moved-owner",
              type: "SCENE_ILLUSTRATION",
              path: "https://api.example/assets/images/project-1/page-2.webp",
              metadata: { [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "page-row-1" }
            },
            {
              id: "hero-moved-from-page-1",
              type: "SCENE_ILLUSTRATION",
              path: "https://api.example/assets/images/project-1/page-1.png",
              metadata: {}
            },
            {
              id: "hero-with-deleted-source",
              type: "SCENE_ILLUSTRATION",
              path: "https://api.example/assets/images/project-1/page-9.png",
              metadata: {}
            },
            {
              id: "manual-replacement",
              type: "DIAGRAM",
              path: "https://api.example/assets/images/project-1/page-2-op-9-user-edit.png",
              metadata: {}
            },
            {
              id: "other-project-path",
              type: "SCENE_ILLUSTRATION",
              path: "https://api.example/assets/images/project-2/page-2.png",
              metadata: {}
            },
            {
              id: "other-kind",
              type: "COVER",
              path: "https://api.example/assets/images/project-1/page-2.png",
              metadata: {}
            }
          ]
        },
        {
          id: "page-row-3",
          index: 3,
          images: [
            {
              id: "old-number-from-another-page",
              type: "SCENE_ILLUSTRATION",
              path: "https://api.example/assets/images/project-1/page-2.webp",
              metadata: {}
            }
          ]
        }
      ]
    );

    expect(update).toHaveBeenCalledTimes(4);
    expect(update).toHaveBeenCalledWith({
      where: { id: "generated-before-reindex" },
      data: {
        metadata: {
          model: "legacy-model",
          [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "page-row-2"
        }
      }
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "hero-moved-from-page-1" },
      data: { metadata: { [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "page-row-1" } }
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "old-number-from-another-page" },
      data: { metadata: { [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "page-row-2" } }
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "hero-with-deleted-source" },
      data: {
        metadata: {
          [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "migrated-legacy-source-missing:9"
        }
      }
    });
  });

  it("keeps an unstamped moved numeric hero through reindex and direct keeper replacement", async () => {
    const source = {
      id: "source-page",
      index: 1,
      title: "Source",
      markdown: "Source prose.",
      summary: "Source summary.",
      revision: 1,
      imagePrompt: "A source hero"
    };
    const destination = {
      id: "destination-page",
      index: 5,
      title: "Destination",
      markdown: "Destination prose.",
      summary: "Destination summary.",
      revision: 1,
      imagePrompt: null as string | null
    };
    const assets = [
      {
        id: "moved-hero",
        projectId: "project-1",
        pageId: destination.id,
        type: "SCENE_ILLUSTRATION",
        path: "https://api.example/assets/images/project-1/page-1.png",
        prompt: "A source hero",
        metadata: {} as Record<string, unknown>
      }
    ];
    const pages = new Map([
      [source.id, source],
      [destination.id, destination]
    ]);
    const imageUpdate = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const asset = assets.find((row) => row.id === where.id);
      if (asset) Object.assign(asset, data);
      return asset;
    });
    const tx = {
      page: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.flatMap((id) => (pages.has(id) ? [pages.get(id)!] : []))
        ),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const page = pages.get(where.id)!;
          Object.assign(page, data, { revision: page.revision + 1 });
          return page;
        }),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      pageEditSnapshot: { create: vi.fn(async () => ({})) },
      imageAsset: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          assets.find((asset) => asset.id === where.id) ?? null
        ),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () =>
          assets
            .filter(
              (asset) =>
                asset.projectId === "project-1" &&
                asset.pageId === destination.id &&
                (asset.type === "SCENE_ILLUSTRATION" || asset.type === "DIAGRAM")
            )
            .map(({ id, path, metadata }) => ({ id, path, metadata }))
        ),
        update: imageUpdate,
        deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
          const ids = where.id.in;
          const before = assets.length;
          for (let index = assets.length - 1; index >= 0; index -= 1) {
            const asset = assets[index]!;
            if (
              asset.projectId === "project-1" &&
              asset.pageId === destination.id &&
              ids.includes(asset.id)
            ) {
              assets.splice(index, 1);
            }
          }
          return { count: before - assets.length };
        })
      }
    };

    await stampLegacyGeneratedIllustrationOwnership(tx as never, "project-1", [
      { id: source.id, index: source.index, images: [] },
      { id: destination.id, index: destination.index, images: assets }
    ]);
    expect(assets[0]).toMatchObject({
      pageId: destination.id,
      metadata: { [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: source.id }
    });

    destination.index = 1;
    assets.push(
      {
        ...assets[0]!,
        id: "same-page-generated",
        metadata: { [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: destination.id }
      },
      {
        ...assets[0]!,
        id: "manual-replacement",
        path: "https://api.example/assets/images/project-1/page-1-op-9-user-edit.png",
        metadata: {}
      },
      {
        ...assets[0]!,
        id: "other-page",
        pageId: source.id,
        metadata: {}
      }
    );
    await stageGeneratedPageWithClient(tx as never, {
      projectId: "project-1",
      chapterId: null,
      pageIndex: 1,
      draft: {
        title: "Replacement keeper",
        markdown: "Replacement prose.",
        summary: "Replacement summary.",
        imagePrompt: "A replacement hero",
        continuityNotes: []
      },
      revision: 2,
      qualityReport: approvedReport,
      status: "GENERATING",
      existingPage: {
        id: destination.id,
        status: "GENERATING",
        title: destination.title,
        markdown: destination.markdown,
        summary: destination.summary,
        imagePrompt: destination.imagePrompt,
        revision: destination.revision,
        updatedAt: new Date("2026-01-01T00:00:00.000Z")
      }
    });

    expect(assets.map((asset) => asset.id).sort()).toEqual(
      ["manual-replacement", "moved-hero", "other-page"].sort()
    );
  });

  it("preserves an already-rendered asset on a same-keeper retry", async () => {
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-row-1",
      status: "GENERATING",
      title: "First",
      markdown: "First text.",
      summary: "First summary.",
      imagePrompt: "A robin on a branch",
      revision: 1,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    });
    strategy.shouldIllustratePage.mockReturnValue(true);

    await reviewAndSaveGeneratedPage(baseOptions("A robin on a branch"));

    expect(mocks.prisma.imageAsset.deleteMany).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
  });

  it("leaves a completed redelivery untouched without replaying provider work", async () => {
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-row-1",
      status: "COMPLETED",
      title: "Already saved",
      markdown: "Durable text.",
      summary: "Durable summary.",
      revision: 4,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    });

    const saved = await reviewAndSaveGeneratedPage(baseOptions("A stale prompt"));

    expect(saved.page).toMatchObject({ title: "Already saved", markdown: "Durable text." });
    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.keeperStoryExtractForSave).not.toHaveBeenCalled();
  });

  it("replaces a completed page when its resumed generation unit explicitly opts in", async () => {
    const completedAt = new Date("2026-01-01T00:00:00.000Z");
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-row-1",
      status: "COMPLETED",
      title: "Old page",
      markdown: "Old text.",
      summary: "Old summary.",
      imagePrompt: null,
      revision: 4,
      updatedAt: completedAt
    });

    const saved = await reviewAndSaveGeneratedPage({
      ...(baseOptions() as object),
      settledPageToReplace: {
        index: 3,
        title: "Old page",
        markdown: "Old text.",
        summary: "Old summary.",
        imagePrompt: null
      }
    } as never);

    expect(saved.page).toMatchObject({ title: "First", markdown: "First text." });
    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "page-row-1", index: 3, status: "COMPLETED", updatedAt: completedAt },
        data: expect.objectContaining({ title: "First", markdown: "First text.", status: "GENERATING" })
      })
    );
  });

  it("keeps a completed winner that changed after the resumed unit was loaded", async () => {
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-row-1",
      status: "COMPLETED",
      title: "New winner",
      markdown: "New durable text.",
      summary: "New durable summary.",
      imagePrompt: null,
      revision: 5,
      updatedAt: new Date("2026-01-02T00:00:00.000Z")
    });

    const saved = await reviewAndSaveGeneratedPage({
      ...(baseOptions() as object),
      settledPageToReplace: {
        index: 3,
        title: "Old page",
        markdown: "Old text.",
        summary: "Old summary.",
        imagePrompt: null
      }
    } as never);

    expect(saved.page).toMatchObject({ title: "New winner", markdown: "New durable text." });
    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
  });

  it("keeps a completed winner whose image prompt alone changed after resume context loaded", async () => {
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-row-1",
      status: "COMPLETED",
      title: "Old page",
      markdown: "Old text.",
      summary: "Old summary.",
      imagePrompt: "A newer winner prompt",
      revision: 5,
      updatedAt: new Date("2026-01-02T00:00:00.000Z")
    });

    const saved = await reviewAndSaveGeneratedPage({
      ...(baseOptions() as object),
      settledPageToReplace: {
        index: 3,
        title: "Old page",
        markdown: "Old text.",
        summary: "Old summary.",
        imagePrompt: "The prompt loaded by the resumed pass"
      }
    } as never);

    expect(saved.page).toMatchObject({ title: "Old page", markdown: "Old text." });
    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
  });
});
