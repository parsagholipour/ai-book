import { beforeEach, expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, FakeTextModelAdapter, pageQualityReportSchema,
  pictureBookReviewFingerprint, pictureBookSceneRepairTargets, type GenerateJsonOptions } from "@book-maker/core";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks } from "./testing/compileExportMocks.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import captured from "./testing/balancedSceneScope2124.json" with { type: "json" };
import { readPictureBookReviewSnapshot, loadPictureBookReviewSnapshot } from "../generation/shortPictureBookReviewCache.js";

vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/jobLifecycle.js", async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock());
vi.mock("../generation/bookHelpers.js", async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock());

beforeEach(() => { vi.clearAllMocks(); });

it.each(["legacy", "explicit"])("repairs Balanced's %s 14–15 interval without unlocking unrelated sentence or evidence pages", async mode => {
  const input = createProjectSchema.parse(captured.input), plan = bookPlanSchema.parse(captured.plan);
  const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
  const pages: ExportPageForRepair[] = captured.pages.map(page => ({ ...page, id: `p${page.index}`, revision: 1,
    status: "COMPLETED", imagePrompt: null, images: [], chapter: null,
    qualityReport: pageQualityReportSchema.parse(captured.reviews[page.index - 1]!.report) }));
  let saved = structuredClone(pages);
  const reviews = structuredClone(captured.reviews);
  if (mode === "explicit") Object.assign(reviews[14]!.findings[0]!, { repairPageIndexes: [14, 15] });
  const snapshot = { fingerprint: pictureBookReviewFingerprint({ input, plan, pages, checks }), reviews };
  const stored = readPictureBookReviewSnapshot(snapshot, { input, plan, pages, checks });
  expect(stored).toBeDefined();
  expect(pictureBookSceneRepairTargets(pages, stored!)).toEqual([{ pageIndex: 15, pageIndexes: [14, 15] }]);
  mocks.prisma.generationJob.findUnique.mockResolvedValue({ projectId: "project", type: "COMPILE_EXPORT", status: "ACTIVE", payload: {
    pictureBookReview: snapshot
  } });
  expect(await loadPictureBookReviewSnapshot({ input, plan, pages, checks, projectId: "project", generationJobId: "compile" })).toBeDefined();
  mocks.loadPagesForExport.mockImplementation(async () => saved);
  mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.$transaction.mockImplementation(async run => run(mocks.prisma));
  mocks.prisma.page.update.mockImplementation(async ({ where, data }) => {
    const index = saved.findIndex(page => page.id === where.id);
    saved[index] = { ...saved[index]!, ...data, revision: saved[index]!.revision + data.revision.increment };
    return saved[index];
  });
  const calls: GenerateJsonOptions<unknown>[] = [], text = new FakeTextModelAdapter();
  // Scripted prose and acceptance isolate the scope contract; this is not a
  // fresh editorial evaluation of the captured book.
  text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
    calls.push(request);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    const payload = JSON.parse(request.messages[1]!.content);
    const raw = request.purpose === "revise-page" ? { pages: [], sceneRevisions: [{
      reason: "Combine both restorations and preserve the route toward the willow.", pages: [
        { pageIndex: 14, markdown: "Rabbit led Turtle back to the fork. He moved the misplaced lantern onto the path hook. Turtle hung the stone lantern beside it.", summary: "Both lanterns return to the path." },
        { pageIndex: 15, markdown: "Two lights marked the trail behind them. Rabbit and Turtle followed the path toward the willow and the missing lights.", summary: "They continue toward the willow." }
      ]
    }] } : { pages: payload.reviewPageIndexes.map((pageIndex: number) => ({ pageIndex, score: 96, findings: [],
      storyExtract: null, styleAudit: null, ...(payload.repairContext.changes.some((change: { pageIndex: number }) => change.pageIndex === pageIndex)
        ? { repairAssessment: { targetResolved: true, meaningPreserved: true, noNewRegressions: true,
          reason: "Scripted acceptance of the complete connected interval." } } : {}) })) };
    return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
  };
  const unavailable = vi.fn();
  await repairPagesFromFinalQa({ projectId: "project", planId: "plan", generationJobId: "compile", input, plan, pages,
    finalQa: { approved: false, score: 75, issues: captured.issues[0]!.messages, requiredFixes: [], notes: "" },
    extraPageIndexes: captured.issues[0]!.pageIndexes, providers: { text },
    strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false },
    quality: { enabled: (feature: string) => feature === "pageModelReview" },
    assertOwnership: vi.fn(), onRepairGroupStarted: vi.fn(async () => true), onRepairGroupPublished: vi.fn(), onRepairPageUnavailable: unavailable
  } as unknown as Parameters<typeof repairPagesFromFinalQa>[0]);
  const payload = JSON.parse(calls[0]!.messages[1]!.content);
  expect(payload.semanticTargetPageIndexes).toEqual([8, 14, 15]);
  expect(payload.sentenceRepairs.map((page: { pageIndex: number }) => page.pageIndex)).toEqual([17, 27, 28]);
  expect(unavailable).not.toHaveBeenCalled();
  expect(calls.map(call => call.purpose)).toEqual(["revise-page", "review-page"]);
  expect(saved.filter(page => page.revision === 2).map(page => page.index)).toEqual([14, 15]);
  expect(saved[16]!.markdown).toBe(pages[16]!.markdown);
});
