import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reviewPageWithQualityGates: vi.fn(),
  updateJobProgress: vi.fn(),
  qualityEnabled: vi.fn()
}));

vi.mock("./pageReview.js", () => ({ reviewPageWithQualityGates: mocks.reviewPageWithQualityGates }));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: mocks.qualityEnabled
  })
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: mocks.updateJobProgress }));

import { composedChaptersStrategy } from "@book-maker/core";
import { reviewPageWithQualityGates as reviewPageWithQualityGatesImpl } from "./pageQualityGateReview.js";
import { reviewWholeBookDraftPages } from "./wholeBookPageReview.js";

const page = {
  index: 1,
  title: "The first page",
  markdown: "Draft prose.",
  summary: "A summary.",
  continuityNotes: [] as string[]
};

const baseOptions = (revisePageDraft: ReturnType<typeof vi.fn>) =>
  ({
    input: { targetPages: 1, temperature: 0.8, mediaSettings: {} },
    plan: { title: "Book", chapters: [] },
    strategy: { revisePageDraft },
    textModel: {},
    pages: [page],
    generationJobId: "job-1"
  }) as never;

describe("reviewWholeBookDraftPages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the first failed report without revising when page QA rewrites are disabled", async () => {
    const failedReport = { approved: false, score: 42, feedback: ["Repeated phrasing."] };
    const revisePageDraft = vi.fn();
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "pageLocalQa");
    mocks.reviewPageWithQualityGates.mockResolvedValue(failedReport);

    const reviewed = await reviewWholeBookDraftPages(baseOptions(revisePageDraft));

    expect(mocks.reviewPageWithQualityGates).toHaveBeenCalledTimes(1);
    expect(mocks.reviewPageWithQualityGates).toHaveBeenCalledWith(
      expect.objectContaining({ allowModelReview: false })
    );
    expect(revisePageDraft).not.toHaveBeenCalled();
    expect(reviewed).toEqual([{ draft: page, qualityReport: failedReport, revision: 1 }]);
  });

  it("propagates a cancelled confirmation while reviewing a revised whole-book page", async () => {
    const cancelled = new DOMException("Cancelled", "AbortError");
    mocks.qualityEnabled.mockReturnValue(true);
    mocks.reviewPageWithQualityGates
      .mockResolvedValueOnce({ approved: false, score: 42, issues: ["Separate local defect."] })
      .mockRejectedValueOnce(cancelled);
    const revisePageDraft = vi.fn().mockResolvedValue(page);
    await expect(reviewWholeBookDraftPages(baseOptions(revisePageDraft))).rejects.toBe(cancelled);
    expect(revisePageDraft).toHaveBeenCalledTimes(1);
  });

  it("attempts at most one revision when page QA rewrites are enabled", async () => {
    const firstReport = { approved: false, score: 42, feedback: ["Repeated phrasing."] };
    const secondReport = { approved: false, score: 55, feedback: ["Still repetitive."] };
    const revisedPage = { ...page, index: 99, markdown: "Revised prose." };
    const revisePageDraft = vi.fn().mockResolvedValue(revisedPage);
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "pageLocalQa" || feature === "pageQaRewrite"
    );
    mocks.reviewPageWithQualityGates.mockResolvedValueOnce(firstReport).mockResolvedValueOnce(secondReport);

    const reviewed = await reviewWholeBookDraftPages(baseOptions(revisePageDraft));

    expect(revisePageDraft).toHaveBeenCalledTimes(1);
    expect(mocks.reviewPageWithQualityGates).toHaveBeenCalledTimes(2);
    expect(reviewed).toEqual([
      {
        draft: { ...revisedPage, index: page.index },
        qualityReport: secondReport,
        revision: 2
      }
    ]);
  });

  it("spends Smart unslop once when the conditional rewrite keeps the page unchanged", async () => {
    const candidateReport = {
      approved: false,
      score: 70,
      issues: ["Smart unslop candidate scan found possible signals."],
      requiredRevisions: ["Inspect candidates contextually."],
      notes: "Candidate review.",
      groundedOk: true,
      unsupportedClaims: [],
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: false
      }
    };
    const approvedReport = { ...candidateReport, approved: true, score: 100, issues: [], requiredRevisions: [] };
    const revisePageDraft = vi.fn().mockResolvedValue(page);
    const decisions = { resolve: vi.fn(), recordOutcome: vi.fn() };
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "smartUnslop" || feature === "pageQaRewrite"
    );
    mocks.reviewPageWithQualityGates
      .mockResolvedValueOnce(candidateReport)
      .mockResolvedValueOnce(approvedReport);

    const reviewed = await reviewWholeBookDraftPages({ ...baseOptions(revisePageDraft), decisions });

    expect(revisePageDraft).toHaveBeenCalledTimes(1);
    expect(mocks.reviewPageWithQualityGates).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ decisions, allowModelReview: false })
    );
    expect(mocks.reviewPageWithQualityGates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ allowSmartUnslop: false, decisions, allowModelReview: false })
    );
    expect(reviewed[0]).toMatchObject({ draft: page, qualityReport: approvedReport, revision: 2 });
  });

  it("does not resolve a Smart Unslop confirmation on the composed finalize path", async () => {
    mocks.reviewPageWithQualityGates.mockImplementation(reviewPageWithQualityGatesImpl);
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "smartUnslop" || feature === "pageQaRewrite" || feature === "pageLocalQa"
    );
    const choose = vi.fn();
    const resolve = vi.fn(async () => ({ choose }));
    const recordOutcome = vi.fn();
    const revisePageDraft = vi.fn();
    const sloppyPage = {
      index: 2,
      title: "Treatment",
      markdown:
        "Here's the thing: treatment takes several steps. At its core, filtration removes particles. " +
        "The result serves as a testament to careful plant operation.",
      summary: "Plant steps.",
      continuityNotes: [] as string[]
    };

    const reviewed = await reviewWholeBookDraftPages({
      ...baseOptions(revisePageDraft),
      pages: [sloppyPage],
      strategy: { ...composedChaptersStrategy, revisePageDraft },
      decisions: { resolve, recordOutcome }
    } as never);

    expect(resolve).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(revisePageDraft).not.toHaveBeenCalled();
    expect(reviewed[0]).toMatchObject({ draft: sloppyPage, revision: 1 });
    expect(reviewed[0]?.qualityReport.approved).toBe(true);
    expect(mocks.reviewPageWithQualityGates).toHaveBeenCalledWith(
      expect.objectContaining({ allowModelReview: false })
    );
    expect(mocks.reviewPageWithQualityGates.mock.calls[0]?.[0]).not.toHaveProperty("decisions");
  });
});
