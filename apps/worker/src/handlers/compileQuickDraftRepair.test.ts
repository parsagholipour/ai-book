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
vi.mock("../generation/pageIllustrationOwnership.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageIllustrationOwnership.js")>("../generation/pageIllustrationOwnership.js");
  return { ...actual, retireGeneratedPageIllustrations: vi.fn(actual.retireGeneratedPageIllustrations) };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
});

import { exportRepairOwnershipFence } from "./compileExportFence.js";
import { retireGeneratedPageIllustrations } from "../generation/pageIllustrationOwnership.js";
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

  const flow = (to: string) => "```figure\n" + JSON.stringify({ kind: "flow", title: "Route", nodes: [
    { id: "a", label: "Submit", shape: "start" }, { id: "b", label: "Admissible?", shape: "decision" },
    { id: "c", label: "Approved", shape: "end" }, { id: "d", label: "Rejected", shape: "end" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c", label: "Yes" }, { from: "b", to, label: "No" }], source: "Records" }) + "\n```";
  function figureRepair(options: { illustrated?: boolean; deferIllustrations?: boolean } = {}) {
    const quickInput = createProjectSchema.parse({ prompt: "How a proposal moves.", category: "SOCIETY", targetPages: 3, mediaSettings: { modelTier: "fast" } });
    const pages = [1, 2, 3].map(index => ({ ...page(), id: `page-${index}`, index,
      markdown: index === 2 ? `The proposal stops when it is inadmissible.\n\n${flow("c")}` : `Context page ${index}.` }));
    const textModel = new FakeTextModelAdapter();
    const generate = vi.spyOn(textModel, "generateJson").mockImplementation(async <T>(request: GenerateJsonOptions<T>) => {
      const raw = request.purpose === "patch-page"
        ? { pages: [{ pageIndex: 2, patches: [{ find: '{"from":"b","to":"c","label":"No"}', replace: '{"from":"b","to":"d","label":"No"}' }] }] }
        : { targetChecks: [{ pageIndex: 2, resolved: true }], regressions: [] };
      return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
    });
    strategy.shouldIllustratePage.mockReturnValue(options.illustrated ?? false);
    const finding = { targets: [2], kind: "contradiction", problem: "The diagram approves an inadmissible proposal.", fix: "Route No to Rejected.",
      evidence: [{ pageIndex: 2, quote: '{"from":"b","to":"c","label":"No"}' }, { pageIndex: 2, quote: "The proposal stops when it is inadmissible." }] };
    const repair = repairOptions(pages[1]!, { input: quickInput, plan: makeFallbackPlan(quickInput), pages,
      providers: { text: textModel, embedding: {} }, quality: quickDraftPageQuality(quickInput, { enabled: () => true }),
      deferIllustrations: options.deferIllustrations ?? false,
      finalQa: { ...finalQa, issues: ["Page 2: The diagram approves an inadmissible proposal.", "Page 3: An unrelated complaint."],
        requiredFixes: ["Page 2: Route No to Rejected."],
        // Page 3's complaint is a finding the screen could not ground: never a target, never an instruction.
        focusedReview: { rejectedFindings: 1, repairGroups: [[2]], unverifiedRepairPageIndexes: [3], findings: [finding] } },
      onRepairGroupStarted: vi.fn(async () => true), onRepairGroupPublished: vi.fn(), onRepairPageUnavailable: vi.fn() });
    return { repair, generate, pages };
  }

  it("repairs a figure page's JSON, under a new revision that retires the page's earlier picture", async () => {
    const { repair, generate, pages } = figureRepair();
    await repairPagesFromFinalQa(repair);
    expect(generate.mock.calls.map(([request]) => request.purpose)).toEqual(["patch-page", "final-book-qa"]);
    const proposal = JSON.parse(generate.mock.calls[0]![0].messages[1]!.content);
    // Only the targets' own complaints, and the finding that quotes the figure shows its JSON.
    expect(proposal.instruction).toBe("");
    expect(proposal.findings).toEqual([expect.objectContaining({ repairPages: [2], fix: "Route No to Rejected." })]);
    expect(proposal.pages.find((p: { index: number }) => p.index === 2).markdown).toContain('"to":"c","label":"No"');
    const write = mocks.prisma.page.update.mock.calls.map(([call]) => call).find((call) => call.where.id === "page-2")!;
    expect(write.data.markdown).toBe(`The proposal stops when it is inadmissible.\n\n${flow("d")}`);
    expect(write.data.revision).toEqual({ increment: 1 });
    expect(vi.mocked(retireGeneratedPageIllustrations)).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ pageIndex: 2, priorKeeper: expect.objectContaining({ pageId: "page-2", markdown: pages[1]!.markdown, revision: 1 }) }));
  });

  it("reaches an illustrated page once finalization defers its picture, and only then", async () => {
    const deferred = figureRepair({ illustrated: true, deferIllustrations: true });
    await repairPagesFromFinalQa(deferred.repair);
    expect(deferred.generate).toHaveBeenCalledTimes(2);
    vi.clearAllMocks();
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    const immediate = figureRepair({ illustrated: true, deferIllustrations: false });
    await repairPagesFromFinalQa(immediate.repair);
    expect(immediate.generate).not.toHaveBeenCalled();
    expect(immediate.repair.onRepairPageUnavailable).toHaveBeenCalledOnce();
  });

  it("saves neither linked page when an untouched dependency changes during verification", async () => {
    const { options } = linkedRepair();
    const context = { ...page(), id: "page-5", index: 5, markdown: "The map shows a cave." };
    mocks.prisma.page.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repairPagesFromFinalQa({ ...options, pages: [context, ...options.pages] })).rejects.toThrow();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

});
