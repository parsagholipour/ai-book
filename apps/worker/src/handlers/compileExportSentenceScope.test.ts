import { beforeEach, expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, makeFallbackPlan, pictureBookPageReview,
  pictureBookReviewFingerprint, validatedPictureBookReviewRow, type GenerateJsonOptions } from "@book-maker/core";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks } from "./testing/compileExportMocks.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import captured from "../../../../packages/core/src/generation/testing/sentenceScope0000.json" with { type: "json" };
import { readPictureBookReviewSnapshot } from "../generation/shortPictureBookReviewCache.js";

vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/jobLifecycle.js", async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock());
vi.mock("../generation/bookHelpers.js", async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock());

beforeEach(() => { vi.clearAllMocks(); });

it.each(["legacy", "typed"])("retains %s sentence scope through saved review loading, correction and publication guards", async mode => {
  const input = createProjectSchema.parse(captured.input), plan = makeFallbackPlan(input);
  const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
  const validator = validatedPictureBookReviewRow({ input, checks, pages: new Map(captured.pages.map(page => [page.index, page])) });
  const reviews = captured.pages.map(page => pictureBookPageReview(validator.parse({ pageIndex: page.index, score: 80,
    findings: captured.findings.filter(f => f.pageIndex === page.index).map(({ pageIndex, ...finding }) => ({ ...finding,
      ...(mode === "typed" && [1, 26].includes(pageIndex) ? { repairKind: "sentence_length",
        message: "The measured reading limit needs a sentence split here.", guidance: "Split that sentence and retain every event." } : {})
    })), storyExtract: null, styleAudit: null
  }), page, checks, input.prompt));
  const pages: ExportPageForRepair[] = captured.pages.map(page => ({ ...page, id: `p${page.index}`, revision: 1,
    status: reviews[page.index - 1]!.report.approved ? "COMPLETED" : "FAILED_QA", imagePrompt: null, images: [], chapter: null,
    qualityReport: reviews[page.index - 1]!.report }));
  const snapshot = { fingerprint: pictureBookReviewFingerprint({ input, plan, pages, checks }), reviews };
  const stored = readPictureBookReviewSnapshot(JSON.parse(JSON.stringify(snapshot)), { input, plan, pages, checks });
  expect(stored).toBeDefined();
  if (mode === "typed") expect(stored![0]!.findings![0]!.repairKind).toBe("sentence_length");
  mocks.prisma.generationJob.findUnique.mockResolvedValue({ projectId: "project", type: "COMPILE_EXPORT", status: "ACTIVE",
    payload: { pictureBookReview: snapshot } });
  const calls: GenerateJsonOptions<unknown>[] = [], text = new FakeTextModelAdapter();
  text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
    calls.push(request);
    // A semantic rewrite of this short sentence must fail before paid review or a database write.
    const raw = { pages: [{ pageIndex: 1, summary: null, reason: "Replace the opening event",
      patches: [{ find: "Now the woodland path went dark.", replace: "Rabbit ran to the gate with a spare lantern." }] }] };
    return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
  };
  const unavailable = vi.fn(), published = vi.fn();
  const result = await repairPagesFromFinalQa({ projectId: "project", planId: "plan", generationJobId: "compile", input, plan, pages,
    finalQa: { approved: false, score: 78, issues: mode === "legacy" ? captured.issues[0]!.messages : reviews.flatMap(review =>
      [...review.report.issues, ...review.report.requiredRevisions].map(message => `Page ${review.pageIndex}: ${message}`)),
      requiredFixes: [], notes: "" }, extraPageIndexes: captured.issues[0]!.pageIndexes, providers: { text },
    strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false },
    quality: { enabled: (feature: string) => feature === "pageModelReview" },
    assertOwnership: vi.fn(), onRepairGroupStarted: vi.fn(async () => true), onRepairGroupPublished: published, onRepairPageUnavailable: unavailable
  } as unknown as Parameters<typeof repairPagesFromFinalQa>[0]);
  expect(calls.map(call => call.purpose)).toEqual(["revise-page", "revise-page"]);
  for (const call of calls) {
    const payload = JSON.parse(call.messages[1]!.content);
    expect(payload.sentenceRepairs.map((page: { pageIndex: number }) => page.pageIndex)).toEqual([1, 26]);
    expect(payload.semanticTargetPageIndexes).toEqual([7, 8, 9]);
  }
  expect(unavailable).toHaveBeenCalled();
  expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  expect(published).not.toHaveBeenCalled();
  expect(result).toEqual(pages);
});
