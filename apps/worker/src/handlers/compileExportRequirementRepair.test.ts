import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, FakeTextModelAdapter, pictureBookReviewFingerprint,
  reviewPictureBookManuscript, reviewManuscriptCoverage, manuscriptCoverageSchema, pictureBookRequirementTargets, type GenerateJsonOptions, type PictureBookRequirementTarget } from "@book-maker/core";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks } from "./testing/compileExportMocks.js";
import captured from "./testing/premiumPatternRepair.json" with { type: "json" };
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import { readPictureBookReviewSnapshot, shortPictureBookChecks } from "../generation/shortPictureBookReviewCache.js";

const input = createProjectSchema.parse(captured.input);
const plan = bookPlanSchema.parse(captured.plan);
type Mode = "historic" | "unresolved" | "missing" | "resolved" | "regression" | "bad_evidence";
const comparison = "Grass beside post two bent in the same direction as the grass at post one. Wise Turtle pointed from the flattened grass to the trapped lantern. “Both blew the same way,” he said.";
const requirementQuote = "Wise Turtle notices a pattern in where the lanterns blew";

describe("captured Premium requirement repair", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  async function setup(mode: Mode = "historic") {
    const text = new FakeTextModelAdapter();
    text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
      const raw = request.purpose === "review-picture-book-continuity" ? { findings: [] } : captured.initialReview;
      return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
    };
    const pages = captured.pages.map(p => ({ ...p, summary: "" }));
    const reviews = await reviewPictureBookManuscript({ input, plan, pages, checks: captured.checks, chapterBriefs: [], textModel: text });
    const originals: ExportPageForRepair[] = pages.map(p => ({ ...p, id: `p${p.index}`, revision: 1, imagePrompt: null,
      images: [], chapter: null, status: p.index === 10 ? "FAILED_QA" : "COMPLETED", qualityReport: reviews[p.index - 1]!.report }));
    const job = { projectId: "project", type: "COMPILE_EXPORT", status: "ACTIVE", payload: { pictureBookReview: { fingerprint: pictureBookReviewFingerprint({ input, plan, pages, checks: captured.checks }), reviews } } };
    mocks.prisma.generationJob.findUnique.mockResolvedValue(job);
    let saved = structuredClone(originals);
    mocks.loadPagesForExport.mockImplementation(async () => saved);
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.$transaction.mockImplementation(async run => run(mocks.prisma));
    mocks.prisma.page.update.mockImplementation(async ({ where, data }) => {
      const index = saved.findIndex(p => p.id === where.id);
      saved[index] = { ...saved[index]!, ...data, revision: saved[index]!.revision + data.revision.increment };
      return saved[index];
    });
    const calls: GenerateJsonOptions<unknown>[] = [];
    text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
      if (request.purpose === "review-picture-book-continuity") return { data: request.schema.parse({ findings: [] }), text: '{"findings":[]}', provider: "fixture", model: "continuity-fixture" };
      calls.push(request);
      const payload = JSON.parse(request.messages[1]!.content);
      const target: PictureBookRequirementTarget | undefined = payload.repairContext?.requirementTargets?.[0];
      const raw = request.purpose === "revise-page" ? mode === "resolved" ? { pages: [{ pageIndex: 13, summary: null,
        reason: "Resolve the pattern across displaced lanterns when the second lantern is discovered, after page 10's first clue.",
        patches: [{ find: pages[12]!.markdown, replace: `${pages[12]!.markdown} ${comparison}` }] }] } : captured.patch
        : { pages: captured.candidateReview.pages.filter(row => payload.reviewPageIndexes.includes(row.pageIndex)).map(row => ({ ...row,
          ...(row.pageIndex === (mode === "resolved" ? 13 : 10) ? { repairAssessment: { targetResolved: true,
            meaningPreserved: true, noNewRegressions: true, reason: "Scripted comparison; the separate requirement assessment remains authoritative." } } : {}),
          findings: mode === "historic" ? row.findings : [],
          ...(row.pageIndex === 10 && target && mode !== "missing" ? { requirementAssessments: [{ findingId: target.id,
            resolved: ["resolved", "regression", "bad_evidence"].includes(mode), noNewRegressions: mode !== "regression",
            reason: mode === "resolved" ? "The later comparison connects both lantern locations after the second is discovered."
              : mode === "regression" ? "Turtle knows about the second lantern before discovering it."
              : "More detail at post one still does not establish a shared pattern across displaced lanterns.",
            evidence: mode === "resolved" ? [...target.evidence, { pageIndex: 13, quote: comparison }]
              : mode === "bad_evidence" ? [{ pageIndex: 13, quote: "A comparison that does not occur in the candidate." }]
              : [{ pageIndex: 10, quote: captured.candidateReview.pages[9]!.findings[0]!.quote }] }] } : {}),
          storyExtract: row.storyExtract === "reuse" ? captured.initialReview.pages[row.pageIndex - 1]!.storyExtract : row.storyExtract })) };
      return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
    };
    const unavailable = vi.fn();
    const options = { projectId: "project", planId: "plan", generationJobId: "compile", input, plan, pages: originals,
      finalQa: { approved: false, score: 78, issues: captured.repairIssues[0]!.messages, requiredFixes: [], notes: "" },
      extraPageIndexes: [10], providers: { text }, strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false },
      quality: { enabled: (feature: string) => ["pageModelReview", "storyExtractAudit", "styleAuditor", "styleExcerpts"].includes(feature) },
      assertOwnership: vi.fn(), onRepairGroupStarted: vi.fn(async () => true), onRepairGroupPublished: vi.fn(), onRepairPageUnavailable: unavailable
    } as unknown as Parameters<typeof repairPagesFromFinalQa>[0];
    expect(shortPictureBookChecks(options.quality)).toEqual(captured.checks);
    expect(readPictureBookReviewSnapshot(job.payload.pictureBookReview, { input, plan, pages, checks: captured.checks })?.find(r => r.pageIndex === 10)?.findings).toHaveLength(1);
    return { options, originals, calls, unavailable, job, saved: () => saved };
  }

  it("carries the exact missing obligation and its cross-lantern acceptance criterion through the saved review into repair", async () => {
    const test = await setup();
    await repairPagesFromFinalQa(test.options);
    const request = JSON.parse(test.calls[0]!.messages[1]!.content);
    expect(request.requirementTargets).toEqual([expect.objectContaining({
      requirementQuote, pageIndex: 10,
      acceptanceCriteria: expect.stringContaining("comparison to another displaced lantern"),
      evidence: expect.arrayContaining([expect.objectContaining({ pageIndex: 10, quote: expect.stringContaining("Grass near post one") })])
    })]);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    // The final correction repeats the rejected prose; skip a redundant review.
    expect(test.calls.map(call => call.purpose)).toEqual(["revise-page", "review-page", "revise-page"]);
    expect(test.unavailable.mock.calls[0]![2]).toMatchObject({ failureClass: "target_unresolved" });
  });

  it.each(["unresolved", "missing", "regression", "bad_evidence"] as const)("rejects a clean-looking candidate with %s resolution evidence", async mode => {
    const test = await setup(mode);
    await repairPagesFromFinalQa(test.options);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(test.saved()).toEqual(test.originals);
    expect(test.unavailable).toHaveBeenCalledOnce();
    expect(test.calls.length).toBeLessThanOrEqual(4);
  });

  it("accepts evidence from a later scene and saves its assessment atomically without another model call", async () => {
    const test = await setup("resolved");
    await repairPagesFromFinalQa(test.options);
    expect(test.unavailable).not.toHaveBeenCalled();
    expect(test.calls.map(call => call.purpose)).toEqual(["revise-page", "review-page"]);
    expect(test.saved()[9]!.markdown).toBe(test.originals[9]!.markdown);
    expect(test.saved()[9]!.revision).toBe(1);
    expect(test.saved()[12]!.markdown).toContain(comparison);
    expect(test.saved()[12]!.revision).toBe(2);
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: { payload: expect.objectContaining({
      pictureBookFinalReview: expect.objectContaining({ reviews: expect.arrayContaining([expect.objectContaining({ pageIndex: 10,
        requirementAssessments: [expect.objectContaining({ resolved: true, evidence: expect.arrayContaining([{ pageIndex: 13, quote: comparison }]) })] })]) }) }) } }));
    expect(test.options.onRepairGroupPublished).toHaveBeenCalledOnce();
  });

  it("replays the captured conflicting coverage without erasing Rabbit's independently missing trait", async () => {
    const test = await setup();
    const requirements = manuscriptCoverageSchema.parse(captured.coverage).requirements.filter(r => [requirementQuote, "Rabbit is playful and hasty"].includes(r.quote));
    const targets = pictureBookRequirementTargets(input.prompt, test.originals, test.job.payload.pictureBookReview.reviews);
    const text = new FakeTextModelAdapter();
    const reviewCalls: GenerateJsonOptions<unknown>[] = [];
    text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
      if (request.purpose === "review-picture-book-continuity") return { data: request.schema.parse({ findings: [] }), text: '{"findings":[]}', provider: "fixture", model: "continuity-fixture" };
      reviewCalls.push(request);
      const raw = { complete: true, requirements: requirements.map((r, index) => ({ ...r, id: `brief-${index + 1}` })) };
      return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
    };
    const coverage = await reviewManuscriptCoverage({ brief: input.prompt, pages: test.originals, promises: [], requirementTargets: targets,
      textModel: text, inventory: { status: "available", brief: input.prompt, complete: true, requirements },
      evidenceContext: { title: plan.title, targetStoryPages: 30, storyPageIndexes: test.originals.map(p => p.index),
        illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: plan.characters ?? [], referenceProvenance: [] } });
    expect(coverage.requirements.find(r => r.quote === requirementQuote)).toMatchObject({ status: "unverified", reason: expect.stringContaining("Reviewers disagree") });
    expect(coverage.requirements.find(r => r.quote === "Rabbit is playful and hasty")).toMatchObject({ status: "missing" });
    expect(reviewCalls).toHaveLength(1);
  });

  it("discards structured findings when any part of the original manuscript changes", async () => {
    const test = await setup();
    const pages = test.originals.map(p => p.index === 30 ? { ...p, markdown: `${p.markdown} A later edit.` } : p);
    expect(readPictureBookReviewSnapshot(test.job.payload.pictureBookReview, { input, plan, pages, checks: captured.checks })).toBeUndefined();
  });
});
vi.mock("./compileFinalization.js", async () => (await import("./testing/compileExportMocks.js")).compileFinalizationModuleMock());
vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/jobLifecycle.js", async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock());
vi.mock("../generation/bookHelpers.js", async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock());
