import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectSchema, makeFallbackPlan, reviewPageDraftLocally, reviewPageDraft, revisePageDraft,
  pageQualityReportSchema, FakeTextModelAdapter, type RevisePageOptions, type GenerateJsonOptions } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import captured from "../../../../packages/core/src/generation/testing/balancedSentenceRepair.json" with { type: "json" };
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


import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks, isDefaultCompileQualityFeature } from "./testing/compileExportMocks.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle restore the lanterns before moonrise.", category: "KIDS", targetPages: 30,
  mediaSettings: { audienceAgeRange: "6-8", modelTier: "fast" } });
const plan = makeFallbackPlan(input);
const markdown = "Wise Turtle asked the neighbors to wait at clear spots beside the trail. “Leave room for Rabbit to come back,” Wise Turtle said. The neighbors moved away from the fork and settled where they could see the path. Rabbit hurried into the ferns, with open space for the search ahead.";
const find = "The neighbors moved away from the fork and settled where they could see the path.";
const replace = "The neighbors moved away from the fork. They settled where they could see the path.";
const draft = { title: "Room Along the Trail", markdown, summary: "Turtle keeps the neighbors clear while Rabbit searches.", imagePrompt: "The original waiting scene.", continuityNotes: [] };
const report = reviewPageDraftLocally({ input, plan, pageIndex: 18, draft, previousPages: [], continuityNotes: [] });
const page: ExportPageForRepair = { id: "page-18", projectId: "project-1", index: 18, ...draft, status: "FAILED_QA", qualityReport: report, revision: 1, images: [], chapter: null } as unknown as ExportPageForRepair;
const approved = pageQualityReportSchema.parse({ approved: true, score: 94, issues: [], requiredRevisions: [], notes: "Meaning and handoff preserved.", checks: { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: true, progressionOk: true, styleNatural: true } });

describe("final repair preserves reader prose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.parseChapterBrief.mockReturnValue(undefined);
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...page, ...data, revision: 2, updatedAt: new Date() }));
    mocks.revisePageDraftWithRestart.mockImplementation(async ({ reviseOptions }: { reviseOptions: RevisePageOptions }) => revisePageDraft(reviseOptions));
  });

  const run = async (invalid: boolean) => {
    const calls: Array<{ purpose: string | undefined; payload: Record<string, unknown> }> = [];
    const text = new FakeTextModelAdapter();
    text.generateJson = async <T,>(options: GenerateJsonOptions<T>) => {
      const payload = JSON.parse(options.messages[1]!.content) as Record<string, unknown>;
      calls.push({ purpose: options.purpose, payload });
      const raw = options.purpose === "revise-page" ? { patches: [{ find: invalid ? "missing span" : find, replace }] } : approved;
      return { data: options.schema.parse(raw), text: JSON.stringify(raw), provider: "test", model: "test" };
    };
    const strategy = { executionMode: "whole-book", revisePageDraft, reviewPageDraft, repairPageBrief: vi.fn(), shouldIllustratePage: () => false };
    await repairPagesFromFinalQa({ projectId: "project-1", input, plan, providers: { text, embedding: {} }, strategy,
      quality: { enabled: isDefaultCompileQualityFeature }, pages: [page],
      finalQa: { approved: false, score: 60, issues: report.issues.map((issue) => `Page 18: ${issue}`), requiredFixes: [], notes: "Local age gate.", repairPageIndexes: [18] }, generationJobId: "gj-1" } as never);
    return { calls, strategy };
  };

  it("keeps the captured page's scene and metadata through one actual patch, configured review, and publication", async () => {
    const { calls, strategy } = await run(false);
    expect(calls.map((call) => call.purpose)).toEqual(["revise-page", "review-page"]);
    expect(calls[1]!.payload.sentenceRepair).toMatchObject({ originalMarkdown: markdown });
    expect(strategy.repairPageBrief).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      title: draft.title, summary: draft.summary, imagePrompt: draft.imagePrompt, markdown: markdown.replace(find, replace), status: "COMPLETED"
    }) }));
  });

  it("keeps the original failed keeper and stops when the patch cannot be applied", async () => {
    const { calls, strategy } = await run(true);
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.purpose === "revise-page" && call.payload.pageMarkdown === markdown)).toBe(true);
    expect(strategy.repairPageBrief).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ markdown, status: "FAILED_QA" }) }));
  });

  it.each(["existing repetition", "introduced regression"])("stops sentence repair on %s without replotting or keeping an unapproved edit", async (failure) => {
    const original = captured.originalDraft;
    const previousPages = captured.previousPages;
    const local = reviewPageDraftLocally({ input, plan, pageIndex: 30, draft: original, previousPages, continuityNotes: [] });
    expect(local.issues).toHaveLength(1);
    expect(local.issues[0]).toContain("Sentences are too long");
    const replacement = failure === "existing repetition" ? captured.patch.patches[0]!.replace
      : "The moon hangs over Moonberry Meadow. Everyone leaves without sharing the picnic.";
    const rejected = failure === "existing repetition" ? captured.rejectedReview : { ...approved, approved: false, score: 90,
      issues: ["The patch reverses the ending: everyone leaves without sharing the picnic."], requiredRevisions: ["Preserve the original shared picnic."] };
    const calls: Array<string | undefined> = [];
    const text = new FakeTextModelAdapter();
    text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
      calls.push(request.purpose);
      const payload = JSON.parse(request.messages[1]!.content);
      const raw = request.purpose !== "revise-page" ? rejected : payload.pageMarkdown
        ? { patches: [{ find: captured.patch.patches[0]!.find, replace: replacement }] }
        : { ...original, markdown: original.markdown.replace(captured.patch.patches[0]!.find, replacement) };
      return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "test", model: "test" };
    };
    const strategy = { executionMode: "whole-book", revisePageDraft, reviewPageDraft, repairPageBrief: vi.fn(), shouldIllustratePage: () => false };
    await repairPagesFromFinalQa({ projectId: "project-1", input, plan, providers: { text, embedding: {} }, strategy,
      quality: { enabled: isDefaultCompileQualityFeature }, pages: [{ ...page, index: 30, ...original, qualityReport: local }],
      finalQa: { approved: false, score: 60, issues: local.issues.map((issue) => `Page 30: ${issue}`), requiredFixes: [],
        notes: "Local age gate.", repairPageIndexes: [30] }, generationJobId: "gj-1" } as never);
    expect(calls).toEqual(["revise-page", "review-page"]);
    expect(strategy.repairPageBrief).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      markdown: original.markdown, status: "FAILED_QA"
    }) }));
  });

  it("preserves original reader naming through the first export repair review and later attempts", async () => {
    const original = "Wise Turtle set the fourth lantern beside the creek. The neighbors crossed the bridge while Rabbit checked the dark path. Turtle called them back to the light.";
    const leaked = "Wise Turtle set L4 beside the creek. The neighbors waited on the near bank while Rabbit checked the dark path. Turtle kept them close to the light.";
    const corrected = leaked.replace("L4", "the fourth lantern");
    const bridgeReport = pageQualityReportSchema.parse({ approved: false, score: 65,
      issues: ["The neighbors cross the creek before the next page's crossing."], requiredRevisions: ["Keep the neighbors on the near bank."] });
    const leakReport = pageQualityReportSchema.parse({ approved: false, score: 55,
      issues: ['Planning label "L4" replaces the established fourth lantern.'], requiredRevisions: ['Restore "the fourth lantern".'], checks: { promptLeakFree: false } });
    const captured: Array<Record<string, unknown>> = [];
    const answers = [{ ...draft, markdown: leaked }, leakReport, { ...draft, markdown: corrected }, approved];
    const text = new FakeTextModelAdapter();
    text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
      captured.push(JSON.parse(request.messages[1]!.content));
      const answer = answers.shift();
      if (!answer) throw new Error("Unexpected additional model call");
      return { data: request.schema.parse(answer), text: JSON.stringify(answer), provider: "test", model: "test" };
    };
    const strategy = { executionMode: "whole-book", revisePageDraft, reviewPageDraft, shouldIllustratePage: () => false };
    await repairPagesFromFinalQa({ projectId: "project-1", input, plan, providers: { text, embedding: {} }, strategy,
      quality: { enabled: (feature: string) => feature === "pageModelReview" || feature === "pageQaRewrite" }, pages: [{ ...page, markdown: original, qualityReport: bridgeReport }],
      finalQa: { approved: false, score: 65, issues: bridgeReport.issues.map((issue) => `Page 18: ${issue}`), requiredFixes: bridgeReport.requiredRevisions,
        notes: "Creek transition.", repairPageIndexes: [18] }, generationJobId: "gj-1" } as never);
    expect(captured).toHaveLength(4);
    for (const review of [captured[1], captured[3]]) expect(review).toMatchObject({ repairOriginalMarkdown: original });
    expect(mocks.prisma.page.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ markdown: corrected, status: "COMPLETED" }) }));
  });
});
