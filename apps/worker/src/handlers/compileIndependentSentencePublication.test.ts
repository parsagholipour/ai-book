import { beforeEach, expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, FakeTextModelAdapter, pictureBookPageReview, pictureBookFindingSchema,
  pictureBookReviewFingerprint, type GenerateJsonOptions } from "@book-maker/core";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks } from "./testing/compileExportMocks.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import captured from "./testing/quickIndependentRepair0928.json" with { type: "json" };

vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/jobLifecycle.js", async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock());
vi.mock("../generation/bookHelpers.js", async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock());
beforeEach(() => { vi.clearAllMocks(); });

it("publishes only page 18 after rechecking all 30 pages, with restored scenes still FAILED_QA", async () => {
  const input = createProjectSchema.parse(captured.input), plan = bookPlanSchema.parse(captured.plan);
  // Replay the independent repair defect without reinterpreting this old review
  // against the newly introduced pre-repair checklist.
  delete plan.requirementInventory;
  const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
  const reviews = captured.pages.map(page => pictureBookPageReview({ pageIndex: page.index, score: 96,
    findings: page.index === 20 ? [pictureBookFindingSchema.parse(captured.sceneReview.findings[0]!)] : [], storyExtract: null, styleAudit: null }, page, checks, input.prompt));
  const sentenceIssue = "Sentences are too long for ages 6-8 (average 12.8 words, longest 15; target average <= 12, longest <= 22).";
  const pages: ExportPageForRepair[] = captured.pages.map(page => ({ ...page, id: `p${page.index}`, revision: 1,
    status: [18, 20].includes(page.index) ? "FAILED_QA" : "COMPLETED", imagePrompt: null, images: [], chapter: null,
    qualityReport: page.index === 18 ? { ...reviews[17]!.report, approved: false, issues: [sentenceIssue], requiredRevisions: [] } : reviews[page.index - 1]!.report }));
  let saved = structuredClone(pages);
  mocks.prisma.generationJob.findUnique.mockResolvedValue({ projectId: "project", type: "COMPILE_EXPORT", status: "ACTIVE", payload: {
    pictureBookReview: { fingerprint: pictureBookReviewFingerprint({ input, plan, pages, checks }), reviews }
  } });
  mocks.loadPagesForExport.mockImplementation(async () => saved);
  mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.$transaction.mockImplementation(async run => run(mocks.prisma));
  mocks.prisma.page.update.mockImplementation(async ({ where, data }) => {
    const index = saved.findIndex(page => page.id === where.id);
    saved[index] = { ...saved[index]!, ...data, revision: saved[index]!.revision + data.revision.increment }; return saved[index];
  });
  const calls: GenerateJsonOptions<unknown>[] = [], text = new FakeTextModelAdapter();
  text.generateJson = async request => {
    calls.push(request);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    const payload = JSON.parse(request.messages[1]!.content);
    const isolated = payload.repairContext?.changes.length === 1;
    const raw = request.purpose === "revise-page" ? captured.patch : request.purpose === "review-picture-book-continuity" ? { findings: [] }
      : { pages: payload.reviewPageIndexes.map((pageIndex: number) => ({ pageIndex, score: 96, findings: [], storyExtract: null, styleAudit: null,
        ...(payload.repairContext.changes.some((change: { pageIndex: number }) => change.pageIndex === pageIndex) ? { repairAssessment: {
          targetResolved: isolated || pageIndex === 18, meaningPreserved: true, noNewRegressions: true,
          reason: isolated ? "The exact restored manuscript preserves meaning and resolves page 18." : "Page 18 is fixed, but the scene still repeats."
        } } : {}) })) };
    return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
  };
  const unavailable = vi.fn(), published = vi.fn();
  await repairPagesFromFinalQa({ projectId: "project", planId: "plan", generationJobId: "compile", input, plan, pages,
    finalQa: { approved: false, score: 75, issues: [`Page 18: ${sentenceIssue}`, `Page 20: ${reviews[19]!.report.issues[0]}`], requiredFixes: [], notes: "" },
    extraPageIndexes: [18, 20], providers: { text }, strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false },
    quality: { enabled: (feature: string) => feature === "pageModelReview" }, assertOwnership: vi.fn(),
    onRepairGroupStarted: vi.fn(async () => true), onRepairGroupPublished: published, onRepairPageUnavailable: unavailable
  } as unknown as Parameters<typeof repairPagesFromFinalQa>[0]);
  expect(JSON.parse(calls[0]!.messages[1]!.content).sceneBoundaries).toEqual([{ pageIndexes: [20, 21, 22], beforePageIndex: 19, afterPageIndex: 23 }]);
  expect(unavailable).not.toHaveBeenCalled();
  expect(published).toHaveBeenCalledTimes(1);
  expect(saved.filter(page => page.revision === 2).map(page => page.index)).toEqual([18]);
  expect(saved[19]!.status).toBe("FAILED_QA");
  expect(saved[19]!.qualityReport).toMatchObject({ approved: false, issues: reviews[19]!.report.issues });
  const assessments = calls.filter(call => call.purpose === "review-page");
  expect(assessments).toHaveLength(2);
  const recombined = JSON.parse(assessments[1]!.messages[1]!.content);
  expect(recombined.pages).toHaveLength(30);
  expect(recombined.pages[19].markdown).toBe(pages[19]!.markdown);
  expect(recombined.pages[17].markdown).toBe(saved[17]!.markdown);
  expect(calls.filter(call => call.purpose === "review-picture-book-continuity")).toHaveLength(1);
  expect(calls.filter(call => call.purpose === "revise-page")).toHaveLength(2);
  const stored = mocks.prisma.generationJob.update.mock.calls.at(-1)![0].data.payload.pictureBookFinalReview;
  expect(stored.fingerprint).toBe(pictureBookReviewFingerprint({ input, plan, pages: saved, checks }));
  expect(mocks.prisma.page.updateMany).toHaveBeenCalledTimes(30);
});
