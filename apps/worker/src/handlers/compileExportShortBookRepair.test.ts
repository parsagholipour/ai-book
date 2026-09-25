import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectSchema, makeFallbackPlan, FakeTextModelAdapter, pageQualityReportSchema, type GenerateJsonOptions } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import captured from "./testing/quickLanternDraft.json" with { type: "json" };
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks } from "./testing/compileExportMocks.js";
import { ExportRepairSupersededError } from "./compileExportFence.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle recover four lanterns before moonrise. Turtle starts with four matches.", category: "KIDS", targetPages: 30,
  mediaSettings: { audienceAgeRange: "6-8", modelTier: "fast", finalReview: true, fullIllustrations: false, illustrationCadence: "manual" } });
const plan = makeFallbackPlan(input);
const targets = [8, 9, 12, 13];
const pages: ExportPageForRepair[] = captured.pages.map((page) => ({ ...page, id: `p${page.index}`, imagePrompt: null,
  status: targets.includes(page.index) ? "FAILED_QA" : "COMPLETED", revision: 1, images: [], chapter: null,
  qualityReport: pageQualityReportSchema.parse({ approved: false, score: 60, issues: ["Lanterns must stay dark until the first match is used on page 21."], requiredRevisions: [], notes: "", checks: { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: true, progressionOk: false, styleNatural: true } }) }));

describe("coordinated final repair of the captured Quick book", () => {
  let saved: ExportPageForRepair[];
  beforeEach(() => {
    vi.clearAllMocks();
    saved = structuredClone(pages);
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.loadPagesForExport.mockImplementation(async () => saved);
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    // Transaction rollback is observable: no partly repaired book may escape.
    mocks.prisma.$transaction.mockImplementation(async (run) => {
      const before = structuredClone(saved);
      try { return await run(mocks.prisma); } catch (error) { saved = before; throw error; }
    });
    mocks.prisma.page.update.mockImplementation(async ({ where, data }) => {
      const index = saved.findIndex((page) => page.id === where.id);
      saved[index] = { ...saved[index]!, ...data, revision: saved[index]!.revision + data.revision.increment };
      return saved[index];
    });
    mocks.revisePageDraftWithRestart.mockImplementation(() => { throw new Error("Independent page repair attempted against a mixed manuscript"); });
  });

  function setup(mode: "clean" | "regression" | "incomplete" | "invalid" | "local" | "stop" | "checks" = "clean") {
    const calls: Array<GenerateJsonOptions<unknown>> = [];
    const text = new FakeTextModelAdapter();
    text.generateJson = async <T,>(options: GenerateJsonOptions<T>) => {
      calls.push(options);
      expect(mocks.prisma.page.update).not.toHaveBeenCalled();
      if (mode === "stop") throw new StopRequestedError();
      const manuscript = JSON.parse(options.messages[1]!.content).pages as Array<{ index: number; markdown: string }>;
      const raw = options.purpose === "revise-page" ? { pages: targets.map((pageIndex) => ({ pageIndex,
        reason: "Keep recovered lanterns unlit until the later match scene.", summary: "Rabbit carries the unlit lantern.",
        patches: [{ find: mode === "invalid" ? "A nonexistent exact span." : pages[pageIndex - 1]!.markdown,
          replace: mode === "local" ? "TODO: finish this scene." : `Rabbit carried the dark lantern past marker ${pageIndex}. Wise Turtle followed the path.` }] })) }
        : { pages: pages.filter((page) => mode !== "incomplete" || page.index !== 30).map((page) => ({ pageIndex: page.index, score: 96,
          findings: mode === "regression" && page.index === 21 ? [{ domain: "prose", basis: "cross_page", category: "continuity", requirementQuote: null,
            message: "The later match count contradicts the repaired earlier scene.", guidance: "Preserve the original lighting sequence.",
            quote: page.markdown, relatedEvidence: [{ pageIndex: 8, quote: manuscript[7]!.markdown }] }] : [],
          storyExtract: mode === "checks" ? { storyDelta: { factsAdded: [`Scene ${page.index} occurred.`] }, contradictions: [] } : null,
          styleAudit: mode === "checks" ? "clean" : null })) };
      return { data: options.schema.parse(raw), text: JSON.stringify(raw), provider: "test", model: "test" };
    };
    const unavailable = vi.fn();
    const claim = vi.fn(async () => true);
    const fence = vi.fn();
    const options = { projectId: "project", planId: "plan", input, plan, pages,
      finalQa: { approved: true, score: 95, issues: [], requiredFixes: [], notes: "" }, extraPageIndexes: targets,
      providers: { text }, strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false },
      quality: { enabled: (feature: string) => feature === "pageModelReview" || (mode === "local" && feature === "pageLocalQa") || (mode === "checks" && ["storyExtractAudit", "styleAuditor", "styleExcerpts"].includes(feature)) },
      assertOwnership: fence, onRepairGroupStarted: claim, onRepairPageUnavailable: unavailable, onRepairGroupPublished: vi.fn()
    } as unknown as Parameters<typeof repairPagesFromFinalQa>[0];
    return { calls, options, unavailable, claim, fence, run: () => repairPagesFromFinalQa(options) };
  }

  it("spends one repair and one complete review, and publishes no page before the whole candidate passes", async () => {
    const { calls, run, claim } = setup();
    await run();
    expect(calls.map((call) => call.purpose)).toEqual(["revise-page", "review-page"]);
    const repair = JSON.parse(calls[0]!.messages[1]!.content);
    expect(repair.pages[0].markdown).toBe(pages[0]!.markdown);
    expect(repair.pages[20].markdown).toBe(pages[20]!.markdown);
    expect(repair.issues).toHaveLength(4);
    expect(claim).toHaveBeenCalledWith(targets.map((index) => ({ id: `p${index}`, index })));
    const review = JSON.parse(calls[1]!.messages[1]!.content);
    expect(review.pages[7].markdown).toContain("dark lantern");
    expect(review.pages[20].markdown).toBe(pages[20]!.markdown);
    expect(review.repairContext.changes).toHaveLength(4);
    expect(saved[7]!.markdown).toBe(review.pages[7].markdown);
    expect(saved[20]!.markdown).toBe(pages[20]!.markdown);
    expect(saved[7]!.revision).toBe(2);
    expect(saved[20]!.revision).toBe(1);
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
  });

  it.each(["regression", "incomplete", "invalid", "local"] as const)("keeps all original prose after %s without per-page fallback", async (mode) => {
    const test = setup(mode);
    await test.run();
    expect(test.calls.length).toBeLessThanOrEqual(3);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(saved).toEqual(pages);
    expect(test.unavailable).toHaveBeenCalledTimes(4);
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    if (mode === "invalid" || mode === "local") expect(test.calls).toHaveLength(1);
  });

  it("cannot retry the group or rewrite the unstarted subset after a worker restart", async () => {
    const test = setup();
    test.claim.mockResolvedValue(false);
    test.options.shouldRepairPage = (id) => id !== "p8";
    await test.run();
    expect(test.calls).toHaveLength(0);
    expect(test.claim).toHaveBeenCalledWith(targets.map((index) => ({ id: `p${index}`, index })));
    expect(saved).toEqual(pages);
  });

  it("rejects publication if an untouched dependency changed during the review", async () => {
    const test = setup();
    let claimed = 0;
    mocks.prisma.page.updateMany.mockImplementation(async () => ({ count: ++claimed === 21 ? 0 : 1 }));
    await expect(test.run()).rejects.toBeInstanceOf(ExportRepairSupersededError);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(saved).toEqual(pages);
    expect(test.fence).toHaveBeenLastCalledWith(mocks.prisma);
  });

  it("rolls back every patch if publication fails after the first changed page", async () => {
    const test = setup();
    mocks.prisma.project.update.mockRejectedValueOnce(new Error("Database disconnected"));
    await expect(test.run()).rejects.toThrow("Database disconnected");
    expect(saved).toEqual(pages);
  });

  it("rolls back the manuscript if the durable completion stamp cannot be written", async () => {
    const test = setup();
    test.options.onRepairGroupPublished = async () => { throw new Error("Checkpoint write failed"); };
    await expect(test.run()).rejects.toThrow("Checkpoint write failed");
    expect(saved).toEqual(pages);
  });

  it("propagates a user stop without recording an unavailable repair or writing prose", async () => {
    const test = setup("stop");
    await expect(test.run()).rejects.toBeInstanceOf(StopRequestedError);
    expect(test.unavailable).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("reuses grouped story and style audits and atomically rebuilds state without per-page extraction", async () => {
    const test = setup("checks");
    await test.run();
    expect(test.calls.map((call) => call.purpose)).toEqual(["revise-page", "review-page"]);
    expect(mocks.keeperStoryExtractForSave).not.toHaveBeenCalled();
    expect(saved[7]!.storyDelta).toMatchObject({ factsAdded: ["Scene 8 occurred."] });
    expect(mocks.prisma.project.update).toHaveBeenCalledWith(expect.objectContaining({ data: {
      storyState: expect.objectContaining({ facts: expect.arrayContaining([{ pageIndex: 8, text: "Scene 8 occurred." }]) })
    } }));
  });
});
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
