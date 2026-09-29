import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, FakeTextModelAdapter, pictureBookReviewFingerprint,
  type GenerateJsonOptions } from "@book-maker/core";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks } from "./testing/compileExportMocks.js";
import { readPictureBookReviewSnapshot, savedPictureBookReviewSchema } from "../generation/shortPictureBookReviewCache.js";
import captured from "./testing/quickSentenceRepair2124.json" with { type: "json" };

describe("Quick's September 27 sentence repair", () => {
  beforeEach(() => vi.clearAllMocks());

  function setup(unsupportedVeto = false, failure?: "semantic_loss" | "semantic_then_safe" | "incomplete") {
    const input = createProjectSchema.parse(captured.input), plan = bookPlanSchema.parse(captured.plan);
    const pages = captured.pages.map(page => ({ ...page, id: `p${page.index}`, revision: 1,
      status: page.index === 24 ? "FAILED_QA" : "COMPLETED", imagePrompt: null, images: [], chapter: null,
      storyDelta: captured.reviews[page.index - 1]!.storyExtract.storyDelta,
      qualityReport: { ...captured.reviews[page.index - 1]!.report, approved: page.index !== 24,
        issues: page.index === 24 ? captured.issues[0]!.messages : [], requiredRevisions: [] } }));
    let saved = structuredClone(pages);
    const job = { projectId: "project", type: "COMPILE_EXPORT", status: "ACTIVE", payload: { pictureBookReview: {
      fingerprint: pictureBookReviewFingerprint({ input, plan, pages, checks: captured.checks }), reviews: captured.reviews
    } } };
    expect(readPictureBookReviewSnapshot(job.payload.pictureBookReview, { input, plan, pages, checks: captured.checks })).toBeDefined();
    mocks.prisma.generationJob.findUnique.mockResolvedValue(job);
    mocks.loadPagesForExport.mockImplementation(async () => saved);
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.$transaction.mockImplementation(async run => run(mocks.prisma));
    mocks.prisma.page.update.mockImplementation(async ({ where, data }) => {
      const index = saved.findIndex(page => page.id === where.id);
      saved[index] = { ...saved[index]!, ...data, revision: saved[index]!.revision + data.revision.increment };
      return saved[index];
    });
    const text = new FakeTextModelAdapter(), calls: GenerateJsonOptions<unknown>[] = [];
    let reviews = 0, repairs = 0;
    text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
      if (request.purpose === "review-picture-book-continuity") return { data: request.schema.parse({ findings: [] }), text: '{"findings":[]}', provider: "fixture", model: "continuity-fixture" };
      calls.push(request);
      request.textAttemptBudget!.used += 1;
      expect(mocks.prisma.page.update).not.toHaveBeenCalled();
      if (request.purpose === "revise-page") repairs++;
      const lossy = failure === "semantic_loss" || (failure === "semantic_then_safe" && repairs === 1);
      const patch = structuredClone(captured.patch);
      const changedSentence = patch.pages[0]!.patches[0]!;
      if (lossy) changedSentence.replace = "Wise Turtle did not carry lantern one to post one. He fitted it onto its post.";
      const raw = request.purpose === "revise-page" ? patch : {
        reviewedPageIndexes: (failure === "incomplete" ? pages.slice(0, -1) : pages).map(page => page.index), findings: [captured.inheritedFinding],
        assessments: [{ pageIndex: 24, targetResolved: true, meaningPreserved: !lossy,
          reason: "Both actions, their actor, placement and order remain; splitting the sentence changes no event.",
          semanticChanges: lossy ? [{ kind: "negation", originalQuote: changedSentence.find, candidateQuote: changedSentence.replace,
            originalMeaning: "Turtle carries lantern one to post one.", candidateMeaning: "Turtle does not carry lantern one to post one." }] : [],
          ...(unsupportedVeto && reviews++ === 0 ? { meaningPreserved: false, reason: captured.badAssessment.reason } : {}),
          ...(lossy ? { reason: "The edit negates Turtle carrying lantern one." } : {}) }]
      };
      const parsed = request.schema.safeParse(raw);
      if (!parsed.success) {
        const error = new Error(parsed.error.message);
        error.name = "FixtureJsonValidationError";
        throw error;
      }
      return { data: parsed.data, text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
    };
    const unavailable = vi.fn();
    const options = { projectId: "project", planId: "plan", generationJobId: "compile", input, plan, pages,
      finalQa: { approved: false, score: 75, issues: captured.issues[0]!.messages, requiredFixes: [], notes: "" },
      extraPageIndexes: [24], providers: { text }, strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false },
      quality: { enabled: (feature: string) => ["pageLocalQa", "pageModelReview", "storyExtractAudit", "styleExcerpts"].includes(feature) },
      assertOwnership: vi.fn(), onRepairGroupStarted: vi.fn(async () => true), onRepairGroupPublished: vi.fn(), onRepairPageUnavailable: unavailable
    } as unknown as Parameters<typeof repairPagesFromFinalQa>[0];
    return { calls, unavailable, options, original: pages, saved: () => saved, run: () => repairPagesFromFinalQa(options) };
  }

  it.each([false, true])("publishes the captured valid split with a compact full-book check (unsupported veto: %s)", async unsupportedVeto => {
    const test = setup(unsupportedVeto);
    await test.run();
    expect(test.unavailable.mock.calls).toEqual([]);
    expect(test.saved().filter(page => page.revision === 2).map(page => page.index)).toEqual([24]);
    expect(test.saved()[23]!.markdown).toContain("Wise Turtle carried lantern one to post one. He fitted it onto its post.");
    expect(test.saved()[23]!.status).toBe("COMPLETED");
    expect(test.saved()[0]!.markdown).toBe(test.original[0]!.markdown);
    expect(test.saved()[0]!.status).toBe("FAILED_QA");
    expect(test.saved()[0]!.qualityReport.issues.join(" ")).toContain("lantern inventory unclear");
    expect(test.saved().map(page => page.storyDelta)).toEqual(test.original.map(page => page.storyDelta));
    expect(test.calls.map(call => call.purpose)).toEqual(unsupportedVeto ? ["revise-page", "review-page", "review-page"] : ["revise-page", "review-page"]);
    for (const call of test.calls.filter(call => call.purpose === "review-page")) {
      expect(call.maxTokens).toBe(4_000);
      const payload = JSON.parse(call.messages.find(message => message.role === "user")!.content);
      expect(payload.phase).toBe("picture_book_sentence_repair_review");
      expect(payload.pages).toHaveLength(30);
      expect(payload.changes.map((change: { pageIndex: number }) => change.pageIndex)).toEqual([24]);
      expect(payload.pages[29].markdown).toBe(test.original[29]!.markdown);
      expect(JSON.stringify(payload)).not.toContain("factsAdded");
    }
    const snapshot = mocks.prisma.generationJob.update.mock.calls.at(-1)![0].data.payload.pictureBookFinalReview;
    expect(snapshot.reviews).toHaveLength(30);
    snapshot.reviews.forEach((review: unknown) => savedPictureBookReviewSchema.parse(review));
  });

  it.each(["semantic_loss", "incomplete"] as const)("never publishes a %s candidate or buys a full review after compact verification", async failure => {
    const test = setup(false, failure); await test.run();
    expect(test.saved()).toEqual(test.original);
    expect(test.unavailable).toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    const reviews = test.calls.filter(call => call.purpose === "review-page");
    expect(reviews).toHaveLength(failure === "incomplete" ? 2 : 1);
    expect(reviews.every(call => call.maxTokens === 4_000)).toBe(true);
    if (failure === "incomplete") expect(test.calls.filter(call => call.purpose === "revise-page")).toHaveLength(1);
  });

  it("retains the original if an untouched page changes before publication", async () => {
    const test = setup();
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 0 });
    await expect(test.run()).rejects.toThrow("lost the manuscript");
    expect(test.saved()).toEqual(test.original);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("verifies a corrected candidate against the immutable original review within the shared allowance", async () => {
    const test = setup(false, "semantic_then_safe"); await test.run();
    expect(test.unavailable).not.toHaveBeenCalled();
    expect(test.calls.map(call => call.purpose)).toEqual(["revise-page", "review-page", "revise-page", "review-page"]);
    expect(test.calls[1]!.textAttemptBudget).toBe(test.calls[3]!.textAttemptBudget);
    expect(test.calls[3]!.maxTokens).toBe(4_000);
    expect(test.saved()[23]!.markdown).toContain("Wise Turtle carried lantern one to post one. He fitted it onto its post.");
    expect(test.saved().map(page => page.storyDelta)).toEqual(test.original.map(page => page.storyDelta));
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
