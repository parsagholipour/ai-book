import { quickDraftPageQuality } from "../generation/quickDraftReviewPolicy.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter, createProjectSchema, makeFallbackPlan, type FinalBookQa, type PageQualityReport, type GenerateJsonOptions } from "@book-maker/core";
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
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

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
    quality: { enabled: isDefaultCompileQualityFeature },
    pages: [bookPage],
    finalQa,
    assertOwnership: ownership(),
    generationJobId: "gj-1",
    ...overrides
  }) as unknown as Parameters<typeof repairPagesFromFinalQa>[0];

describe("Quick Draft bounded patch repairs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.page.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.parseChapterBrief.mockReturnValue(undefined);
    mocks.loadPagesForExport.mockResolvedValue([page()]);
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: isDefaultCompileQualityFeature });
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

  it("limits Quick Draft to one three-page proposal without page review loops or a fresh budget on resume", async () => {
    const quickInput = createProjectSchema.parse({ prompt: "A bedtime story.", category: "KIDS", targetPages: 6,
      mediaSettings: { modelTier: "fast", finalReview: true } });
    const targets = Array.from({ length: 5 }, (_, i) => ({ ...page(), id: `page-${i + 1}`, index: i + 1 }));
    const textModel = new FakeTextModelAdapter();
    const patchCalls = vi.spyOn(textModel, "generateJson");
    const options = repairOptions(targets[0]!, { providers: { text: textModel, embedding: {} }, input: quickInput, plan: makeFallbackPlan(quickInput), pages: targets,
      quality: quickDraftPageQuality(quickInput, { enabled: () => true }), extraPageIndexes: [1, 2, 3, 4, 5],
      finalQa: { ...finalQa, issues: ["Page 1: Remove a drafting note."] } });
    await repairPagesFromFinalQa(options);
    expect(patchCalls.mock.calls.map(([call]) => JSON.parse(call.messages[1]!.content).targetPageIndexes)).toEqual([[1, 2, 3]]);
    expect(patchCalls.mock.calls.every(([call]) => call.purpose === "patch-page")).toBe(true);
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
    expect(strategy.revisePageDraft).not.toHaveBeenCalled();
    expect(strategy.repairPageBrief).not.toHaveBeenCalled();
    patchCalls.mockClear();
    await repairPagesFromFinalQa({ ...options, shouldRepairPage: (id) => id !== "page-1" });
    expect(patchCalls).not.toHaveBeenCalled();
  });

  function linkedRepair(resolved = true, regression = false) {
    const quickInput = createProjectSchema.parse({ prompt: "Pip finds the cave.", category: "KIDS", targetPages: 16,
      mediaSettings: { modelTier: "fast" } });
    const targets = [15, 16].map(index => ({ ...page(), id: `page-${index}`, index,
      markdown: index === 15 ? "Pip points to the shell." : "The captain checks the shell." }));
    const textModel = new FakeTextModelAdapter();
    const generate = vi.spyOn(textModel, "generateJson").mockImplementation(async <T>(request: GenerateJsonOptions<T>) => {
      const raw = request.purpose === "patch-page" ? { pages: targets.map(p => ({ pageIndex: p.index, patches: [{ find: "shell", replace: "cave" }] })) }
        : { targetChecks: targets.map(p => ({ pageIndex: p.index, resolved })),
          regressions: regression ? [{ pageIndex: 16, reason: "New duplicated paragraph.", quote: "The captain checks the cave." }] : [] };
      return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
    });
    const onRepairGroupPublished = vi.fn();
    const onRepairPageUnavailable = vi.fn();
    const options = repairOptions(targets[0]!, { input: quickInput, plan: makeFallbackPlan(quickInput), pages: targets,
      providers: { text: textModel, embedding: {} }, quality: quickDraftPageQuality(quickInput, { enabled: () => true }),
      finalQa: { ...finalQa, issues: ["Page 15: Use the cave clue.", "Page 16: Use the cave clue."],
        focusedReview: { rejectedFindings: 0, repairGroups: [[15, 16]] } },
      onRepairGroupStarted: vi.fn(async () => true), onRepairGroupPublished, onRepairPageUnavailable });
    return { options, generate, onRepairGroupPublished, onRepairPageUnavailable };
  }

  it.each([[false, false], [true, true]])("keeps every original page when verification rejects any part (%s, %s)", async (resolved, regression) => {
    const { options, onRepairPageUnavailable, generate } = linkedRepair(resolved, regression);
    await repairPagesFromFinalQa(options);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(onRepairPageUnavailable).toHaveBeenCalledTimes(2);
  });

  it("claims the complete context before atomically publishing linked repairs and their budget", async () => {
    const { options, onRepairGroupPublished, generate } = linkedRepair();
    await repairPagesFromFinalQa(options);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.page.update.mock.calls.map(([call]) => call.data.markdown)).toEqual([
      "Pip points to the cave.", "The captain checks the cave."
    ]);
    expect(onRepairGroupPublished).toHaveBeenCalledOnce();
  });

  it("saves neither linked page when an untouched dependency changes during verification", async () => {
    const { options } = linkedRepair();
    const context = { ...page(), id: "page-5", index: 5, markdown: "The map shows a cave." };
    mocks.prisma.page.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repairPagesFromFinalQa({ ...options, pages: [context, ...options.pages] })).rejects.toThrow();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

});
