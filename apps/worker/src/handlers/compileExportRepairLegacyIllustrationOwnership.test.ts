import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalBookQa, PageQualityReport } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

/** Legacy numeric illustration ownership across structural page reindexing. */

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

import { exportRepairOwnershipFence } from "./compileExportFence.js";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import {
  LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY,
  stampLegacyGeneratedIllustrationOwnership
} from "@book-maker/db/pageIllustrationOwnership";
import { mocks } from "./testing/compileExportMocks.js";

const approvedReport = {
  approved: true,
  score: 90,
  issues: [],
  requiredRevisions: [],
  notes: "",
  checks: { repetitionOk: true, progressionOk: true }
} as unknown as PageQualityReport;

const draft = {
  title: "Repaired",
  markdown: "Repaired prose.",
  summary: "Repaired summary.",
  imagePrompt: null,
  continuityNotes: [] as string[]
};

const page = (): ExportPageForRepair =>
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
    chapter: null
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
    assertOwnership: exportRepairOwnershipFence("project-1", 4),
    generationJobId: "gj-1",
    ...overrides
  }) as never;

describe("compile final-QA repair legacy illustration ownership", () => {
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
    strategy.reviewPageDraft.mockResolvedValue(approvedReport);
    strategy.repairPageBrief.mockReset();
    strategy.shouldIllustratePage.mockReturnValue(false);
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...page(),
      ...data,
      revision: 2,
      updatedAt: new Date("2026-01-01T00:00:00.001Z")
    }));
  });

  it("uses the shared retirement rules to keep moved and manual assets during final-QA cleanup", async () => {
    const original = {
      ...page(),
      imagePrompt: "The old scene.",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    } as ExportPageForRepair & { updatedAt: Date };
    const movedBeforeReindex = {
      id: "moved-before-reindex",
      path: "/assets/images/project-1/page-1.webp",
      metadata: {} as Record<string, unknown>
    };
    await stampLegacyGeneratedIllustrationOwnership(
      {
        imageAsset: {
          update: vi.fn(async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
            movedBeforeReindex.metadata = data.metadata;
          })
        }
      } as never,
      "project-1",
      [
        { id: "source-page", index: 1, images: [] },
        { id: original.id, index: 5, images: [{ ...movedBeforeReindex, type: "SCENE_ILLUSTRATION" }] }
      ]
    );
    expect(movedBeforeReindex.metadata).toEqual({
      [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "source-page"
    });
    mocks.prisma.imageAsset.findMany.mockResolvedValue([
      {
        id: "generated-same-owner",
        path: "/assets/images/project-1/page-1.webp",
        metadata: { legacyGeneratedPageId: "page-1" }
      },
      {
        id: "generated-unmarked",
        path: "/assets/images/project-1/page-1.png",
        metadata: null
      },
      movedBeforeReindex,
      {
        id: "manual-operation",
        path: "/assets/images/project-1/page-1-edit-operation.webp",
        metadata: { operationId: "edit-operation" }
      }
    ]);
    mocks.loadPagesForExport.mockResolvedValue([{ ...original, ...draft, images: [] }]);

    await expect(repairPagesFromFinalQa(repairOptions(original, { planId: "plan-1" }))).resolves.toEqual([
      expect.objectContaining({ markdown: "Repaired prose." })
    ]);

    expect(mocks.prisma.imageAsset.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["generated-same-owner", "generated-unmarked"] },
        projectId: "project-1",
        pageId: "page-1"
      }
    });
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
  });

  it("retires a stamped legacy render after its page moves away from the numeric filename", async () => {
    const original = {
      ...page(),
      index: 3,
      imagePrompt: "The old scene.",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    } as ExportPageForRepair & { updatedAt: Date };
    mocks.prisma.imageAsset.findMany.mockResolvedValue([
      {
        id: "generated-before-move",
        path: "/assets/images/project-1/page-2.webp",
        metadata: { legacyGeneratedPageId: original.id }
      },
      {
        id: "render-owned-by-another-page",
        path: "/assets/images/project-1/page-2.png",
        metadata: { legacyGeneratedPageId: "page-2" }
      },
      {
        id: "manual-operation",
        path: "/assets/images/project-1/page-3-edit-operation.webp",
        metadata: { operationId: "edit-operation" }
      }
    ]);
    mocks.loadPagesForExport.mockResolvedValue([{ ...original, ...draft, images: [] }]);

    await expect(
      repairPagesFromFinalQa(
        repairOptions(original, {
          planId: "plan-1",
          finalQa: { ...finalQa, repairPageIndexes: [3] }
        })
      )
    ).resolves.toEqual([expect.objectContaining({ index: 3, markdown: "Repaired prose." })]);

    expect(mocks.prisma.imageAsset.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["generated-before-move"] },
        projectId: "project-1",
        pageId: "page-1"
      }
    });
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
  });
});
