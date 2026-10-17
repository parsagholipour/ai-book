import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reviewPageWithQualityGates: vi.fn(),
  updateJobProgress: vi.fn(),
  qualityEnabled: vi.fn()
}));

vi.mock("./pageReview.js", async () => {
  const { withoutPageReview } = await vi.importActual<typeof import("./pageReview.js")>("./pageReview.js");
  return { reviewPageWithQualityGates: mocks.reviewPageWithQualityGates, withoutPageReview };
});
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

const baseOptions = (revisePageDraft: ReturnType<typeof vi.fn>, strategy: Record<string, unknown> = {}) =>
  ({
    input: { targetPages: 1, temperature: 0.8, mediaSettings: {} },
    plan: { title: "Book", chapters: [] },
    strategy: { revisePageDraft, ...strategy },
    textModel: {},
    pages: [page],
    generationJobId: "job-1"
  }) as unknown as Parameters<typeof reviewWholeBookDraftPages>[0];

/** A composed page's local report that failed an integrity rule `composedPageQualityReport` keeps. */
const leakedReport = {
  approved: false,
  score: 42,
  issues: ["The page leaks a prompt instruction."],
  requiredRevisions: ["Remove the leaked instruction."],
  notes: "",
  groundedOk: true,
  unsupportedClaims: [],
  checks: { placeholderFree: true, promptLeakFree: false, titleClean: true, repetitionOk: true, progressionOk: true, styleNatural: true }
};

describe("reviewWholeBookDraftPages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves a whole-book draft's failing page as drafted, with no revise and no model review", async () => {
    const failedReport = { approved: false, score: 42, feedback: ["Repeated phrasing."] };
    const revisePageDraft = vi.fn();
    mocks.qualityEnabled.mockReturnValue(true);
    mocks.reviewPageWithQualityGates.mockResolvedValue(failedReport);

    const reviewed = await reviewWholeBookDraftPages(baseOptions(revisePageDraft));

    expect(mocks.reviewPageWithQualityGates).toHaveBeenCalledTimes(1);
    const { quality } = mocks.reviewPageWithQualityGates.mock.calls[0]![0] as { quality: { enabled: (feature: string) => boolean } };
    for (const feature of ["pageModelReview", "pageQaRewrite", "smartUnslop", "styleAuditor"]) {
      expect(quality.enabled(feature), feature).toBe(false);
    }
    expect(revisePageDraft).not.toHaveBeenCalled();
    expect(reviewed).toEqual([{ draft: page, qualityReport: failedReport, revision: 1 }]);
  });

  it("revises a composed page whose integrity checks fail, once, under pageQaRewrite", async () => {
    const revisedPage = { ...page, index: 99, markdown: "Revised prose." };
    const revisedReport = { ...leakedReport, approved: true, score: 90, checks: { ...leakedReport.checks, promptLeakFree: true } };
    const revisePageDraft = vi.fn().mockResolvedValue(revisedPage);
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "pageLocalQa" || feature === "pageQaRewrite");
    mocks.reviewPageWithQualityGates.mockResolvedValueOnce(leakedReport).mockResolvedValueOnce(revisedReport);

    const reviewed = await reviewWholeBookDraftPages(baseOptions(revisePageDraft, { ...composedChaptersStrategy, revisePageDraft }));

    expect(revisePageDraft).toHaveBeenCalledTimes(1);
    expect(mocks.reviewPageWithQualityGates).toHaveBeenCalledTimes(2);
    expect(reviewed).toEqual([{ draft: { ...revisedPage, index: page.index }, qualityReport: revisedReport, revision: 2 }]);
  });

  it("keeps a composed page's failed report when page QA rewrites are off", async () => {
    const revisePageDraft = vi.fn();
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "pageLocalQa");
    mocks.reviewPageWithQualityGates.mockResolvedValue(leakedReport);

    const reviewed = await reviewWholeBookDraftPages(baseOptions(revisePageDraft, { ...composedChaptersStrategy, revisePageDraft }));

    expect(revisePageDraft).not.toHaveBeenCalled();
    expect(reviewed[0]).toMatchObject({ draft: page, revision: 1, qualityReport: expect.objectContaining({ approved: false }) });
  });

  it("propagates a cancellation raised while reviewing a revised composed page", async () => {
    const cancelled = new DOMException("Cancelled", "AbortError");
    mocks.qualityEnabled.mockReturnValue(true);
    mocks.reviewPageWithQualityGates.mockResolvedValueOnce(leakedReport).mockRejectedValueOnce(cancelled);
    const revisePageDraft = vi.fn().mockResolvedValue(page);
    await expect(
      reviewWholeBookDraftPages(baseOptions(revisePageDraft, { ...composedChaptersStrategy, revisePageDraft }))
    ).rejects.toBe(cancelled);
    expect(revisePageDraft).toHaveBeenCalledTimes(1);
  });

  it("asks no model about a composed page whose prose only trips the slop scan", async () => {
    mocks.reviewPageWithQualityGates.mockImplementation(reviewPageWithQualityGatesImpl);
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "smartUnslop" || feature === "pageQaRewrite" || feature === "pageLocalQa"
    );
    const revisePageDraft = vi.fn();
    const reviewPageDraft = vi.fn();
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
      strategy: { ...composedChaptersStrategy, revisePageDraft, reviewPageDraft }
    } as never);

    expect(reviewPageDraft).not.toHaveBeenCalled();
    expect(revisePageDraft).not.toHaveBeenCalled();
    expect(reviewed[0]).toMatchObject({ draft: sloppyPage, revision: 1 });
    expect(reviewed[0]?.qualityReport.approved).toBe(true);
    expect(mocks.reviewPageWithQualityGates.mock.calls[0]?.[0]).not.toHaveProperty("decisions");
  });
});
