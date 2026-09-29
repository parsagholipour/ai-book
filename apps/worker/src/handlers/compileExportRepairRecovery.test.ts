import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, FakeTextModelAdapter, pageQualityReportSchema,
  pictureBookReviewFingerprint, type GenerateJsonOptions, type PictureBookPageReview } from "@book-maker/core";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks } from "./testing/compileExportMocks.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import captured from "./testing/repairRecovery2214.json" with { type: "json" };
import { StopRequestedError } from "../runtime/jobTypes.js";
import { ExportRepairSupersededError } from "./compileExportFence.js";

type Tier = keyof typeof captured;
type Mode = "safe" | "still_bad" | "final_bad" | "exhausted" | "review_exhausted" | "local_bad" | "no_candidate";
type ReviewRow = {
  pageIndex: number; score: number; findings: NonNullable<PictureBookPageReview["findings"]>;
  storyExtract: unknown; styleAudit: unknown;
  repairAssessment?: PictureBookPageReview["repairAssessment"];
  requirementAssessments?: PictureBookPageReview["requirementAssessments"];
};

// Exact first candidates/reviews from the 22:14 run; corrections and their
// verdicts are scripted to test recovery/publication, not a fresh model eval.
describe("bounded semantic recovery of the 22:14 repairs", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  function setup(tier: Tier, mode: Mode = "safe") {
    const fixture = captured[tier];
    const input = createProjectSchema.parse(fixture.input), plan = bookPlanSchema.parse(fixture.plan);
    const pages: ExportPageForRepair[] = fixture.pages.map(p => ({ ...p, id: `p${p.index}`, revision: 1,
      imagePrompt: null, images: [], chapter: null, qualityReport: pageQualityReportSchema.parse(p.qualityReport) }));
    let saved = structuredClone(pages);
    const job = { projectId: "project", type: "COMPILE_EXPORT", status: "ACTIVE", payload: { pictureBookReview: {
      fingerprint: pictureBookReviewFingerprint({ input, plan, pages, checks: fixture.checks }), reviews: fixture.reviews
    } } };
    mocks.prisma.generationJob.findUnique.mockResolvedValue(job);
    mocks.loadPagesForExport.mockImplementation(async () => saved);
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.$transaction.mockImplementation(async run => {
      const before = structuredClone(saved);
      try { return await run(mocks.prisma); } catch (error) { saved = before; throw error; }
    });
    mocks.prisma.page.update.mockImplementation(async ({ where, data }) => {
      const index = saved.findIndex(p => p.id === where.id);
      saved[index] = { ...saved[index]!, ...data, revision: saved[index]!.revision + data.revision.increment };
      return saved[index];
    });
    const text = new FakeTextModelAdapter(), calls: GenerateJsonOptions<unknown>[] = [];
    let repairs = 0;
    text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
      if (request.purpose === "review-picture-book-continuity") return { data: request.schema.parse({ findings: [] }), text: '{"findings":[]}', provider: "fixture", model: "continuity-fixture" };
      calls.push(request);
      expect(mocks.prisma.page.update).not.toHaveBeenCalled();
      const payload = JSON.parse(request.messages[1]!.content);
      let raw: unknown;
      if (request.purpose === "revise-page") {
        repairs += 1;
        if (mode === "exhausted") request.textAttemptBudget!.used = request.textAttemptBudget!.limit;
        const patch = structuredClone(fixture.patch);
        if (repairs === 2 && mode !== "still_bad") {
          if (tier === "fast") patch.pages.push({ pageIndex: 17, reason: "Resolve the reported extra crossing; preserve the three accepted edits.",
            patches: [{ find: fixture.pages[16]!.markdown.split(" They brought")[0]!, replace: "On the near bank, Rabbit and Wise Turtle carried the bridge lantern along the creek together." }], summary: null });
          else patch.pages[1]!.patches[0]!.replace = '“Red was east of Stump. Blue was east of Fern,” Rabbit said. Turtle watched a fallen twig drift downstream. “Green could have blown into the stream, then floated toward the rail,” he said. “Let’s look where the water catches things.”';
        }
        if (repairs === 2 && mode === "local_bad") patch.pages[0]!.patches = [{ find: fixture.pages[1]!.markdown, replace: "Too short." }];
        raw = repairs === 2 && mode === "no_candidate" ? { pages: [] } : patch;
      } else {
        const rows = structuredClone(fixture.candidateReview.pages) as ReviewRow[];
        if (repairs === 2 && mode !== "still_bad" && mode !== "final_bad") {
          const row = rows.find(row => row.pageIndex === (tier === "fast" ? 17 : 14))!;
          const repaired = payload.pages.find((page: { index: number }) => page.index === row.pageIndex);
          row.findings = [];
          row.repairAssessment = { targetResolved: true, meaningPreserved: true, noNewRegressions: true,
            reason: "Scripted final verification of the corrected transition against the complete candidate." };
          row.storyExtract = { storyDelta: { factsAdded: [repaired.markdown] }, contradictions: [], contradictionEvidence: [] };
          if (row.requirementAssessments) row.requirementAssessments = row.requirementAssessments.map(a => ({ ...a,
            resolved: true, noNewRegressions: true, reason: "The revised clue keeps the eastward wind and observes the downstream current.",
            evidence: [{ pageIndex: row.pageIndex, quote: repaired.markdown.slice(0, 600) }] }));
        }
        if (repairs === 2 && mode === "final_bad") {
          const row = rows.find(row => row.pageIndex === 14)!;
          // A different correction still fails its semantic assessment, with exact new evidence.
          const quote = payload.pages.find((page: { index: number }) => page.index === 14).markdown.slice(0, 600);
          row.findings = row.findings.map(finding => ({ ...finding, quote }));
          row.requirementAssessments = row.requirementAssessments?.map(a => ({ ...a, evidence: [{ pageIndex: 14, quote }] }));
          row.storyExtract = "no_changes";
        }
        if (mode === "review_exhausted") request.textAttemptBudget!.used = request.textAttemptBudget!.limit;
        if (repairs === 2) for (const row of rows) {
          if (payload.reusableStoryExtractPageIndexes?.includes(row.pageIndex)) row.storyExtract = "reuse";
        }
        raw = { pages: rows.filter(row => payload.reviewPageIndexes.includes(row.pageIndex)) };
      }
      return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
    };
    const unavailable = vi.fn();
    const options = { projectId: "project", planId: "plan", generationJobId: "compile", input, plan, pages,
      finalQa: { approved: false, score: 75, issues: fixture.issues[0]!.messages, requiredFixes: [], notes: "" },
      extraPageIndexes: fixture.issues.flatMap(issue => issue.pageIndexes), providers: { text },
      strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false },
      quality: { enabled: (feature: string) => feature === "pageLocalQa" || feature === "styleExcerpts" || fixture.checks[feature as keyof typeof fixture.checks] === true },
      assertOwnership: vi.fn(), onRepairGroupStarted: vi.fn(async () => true), onRepairGroupPublished: vi.fn(), onRepairPageUnavailable: unavailable
    } as unknown as Parameters<typeof repairPagesFromFinalQa>[0];
    return { options, calls, unavailable, original: pages, saved: () => saved, run: () => repairPagesFromFinalQa(options), job };
  }

  it.each(["fast", "premium"] as const)("corrects %s review failures while retaining the valid edits", async tier => {
    const test = setup(tier); await test.run();
    expect(test.unavailable.mock.calls).toEqual([]);
    expect(test.saved().filter(p => p.revision === 2).map(p => p.index)).toEqual(tier === "fast" ? [2, 13, 17, 28] : [2, 14]);
    expect(test.calls.map(c => c.purpose)).toEqual(["revise-page", "review-page", "revise-page", "review-page"]);
    const feedback = JSON.parse(test.calls[2]!.messages[1]!.content);
    expect(feedback.pages.map((p: { markdown: string }) => p.markdown)).toEqual(test.original.map(p => p.markdown));
    expect(JSON.stringify(feedback.feedback)).toContain(tier === "fast" ? "near bank" : "eastward");
    expect(feedback.feedback.candidatePages.map((p: { index: number }) => p.index)).toEqual(tier === "fast" ? [2, 13, 28] : [2, 14]);
    expect(test.calls[0]!.textAttemptBudget).toBe(test.calls[2]!.textAttemptBudget);
    expect(test.calls[1]!.textAttemptBudget).toBe(test.calls[3]!.textAttemptBudget);
    const finalReview = JSON.parse(test.calls[3]!.messages[1]!.content);
    // Review all prose again, but avoid re-emitting the unchanged state prefix.
    expect(finalReview.reviewPageIndexes).toHaveLength(30);
    expect(finalReview.reusableStoryExtractPageIndexes).toEqual(Array.from({ length: tier === "fast" ? 16 : 13 }, (_, i) => i + 1));
    const savedReview = mocks.prisma.generationJob.update.mock.calls.at(-1)![0].data.payload.pictureBookFinalReview;
    expect(savedReview.fingerprint).toBe(pictureBookReviewFingerprint({ input: test.options.input, plan: test.options.plan,
      pages: test.saved(), checks: captured[tier].checks }));
    expect(savedReview.reviews.every((r: PictureBookPageReview) => r.draftMarkdown === test.saved()[r.pageIndex - 1]!.markdown)).toBe(true);
    expect(test.options.onRepairGroupStarted).toHaveBeenCalledTimes(1);
    expect(test.options.onRepairGroupPublished).toHaveBeenCalledTimes(1);
  });

  it.each(["fast", "premium"] as const)("rejects %s when the final candidate remains unsafe", async tier => {
    const test = setup(tier, "still_bad"); await test.run();
    expect(test.saved()).toEqual(test.original);
    expect(test.unavailable).toHaveBeenCalled();
    expect(test.calls).toHaveLength(3);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it.each(["exhausted", "review_exhausted"] as const)("does not replenish an %s allowance", async mode => {
    const test = setup("premium", mode); await test.run();
    expect(test.saved()).toEqual(test.original);
    expect(test.calls).toHaveLength(2);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it.each(["final_bad", "local_bad", "no_candidate"] as const)("rejects %s corrections without a third candidate", async mode => {
    const test = setup("premium", mode); await test.run();
    expect(test.saved()).toEqual(test.original);
    expect(test.unavailable).toHaveBeenCalled();
    expect(test.calls).toHaveLength(mode === "final_bad" ? 4 : 3);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it.each(["stop", "superseded"] as const)("honors %s before the correction is dispatched", async mode => {
    const test = setup("premium");
    const error = mode === "stop" ? new StopRequestedError() : new ExportRepairSupersededError();
    test.options.assertOwnership = async () => { if (test.calls.length === 2) throw error; };
    await expect(test.run()).rejects.toBe(error);
    expect(test.calls).toHaveLength(2);
    expect(test.unavailable).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("pins repair and review routes and accounts physical attempts across both candidates", async () => {
    const test = setup("premium"), adapter = test.options.providers.text;
    const generate = adapter.generateJson.bind(adapter);
    const counts = new Map<GenerateJsonOptions<unknown>["purpose"], number>();
    adapter.generateJson = async request => {
      const count = (counts.get(request.purpose) ?? 0) + 1;
      counts.set(request.purpose, count);
      request.textAttemptBudget!.used += request.purpose === "revise-page" && count === 1 ? 4 : request.purpose === "review-page" && count === 1 ? 3 : 1;
      expect(request.textAttemptBudget!.used).toBeLessThanOrEqual(5);
      return generate(request);
    };
    const bindForCall = vi.fn(async () => ({ adapter }));
    test.options.providers.text = Object.assign(Object.create(adapter), { bindForCall });
    await test.run();
    expect(bindForCall.mock.calls).toEqual([["revise-page"], ["review-page"], ["review-picture-book-continuity"]]);
    expect(test.calls).toHaveLength(4);
    expect(test.calls.every(call => call.textAttemptBudget!.used === 5)).toBe(true);
    expect(test.unavailable).not.toHaveBeenCalled();
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
